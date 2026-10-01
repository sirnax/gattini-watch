// Recognises cross-tool launches inside shell commands: Claude launching `codex exec`,
// and Codex launching `claude -p`. Only a program in command position counts, so
// `grep "codex exec"` or a quoted mention is ignored, and `--help` probes are skipped.

const COMMAND_START = String.raw`(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:command\s+|exec\s+|nohup\s+|time\s+)?`;
const CODEX_EXEC = new RegExp(`${COMMAND_START}(?:\\S*/)?codex\\s+(?:-{1,2}[\\w-]+(?:[\\s=](?!exec\\b)\\S+)?\\s+)*exec\\b([^\\n;|&]*)`);
const CLAUDE_CLI = new RegExp(`${COMMAND_START}(?:\\S*/)?claude\\b([^\\n;|&]*)`);
const HELP = /(?:^|\s)(?:--help|-h|help)(?:\s|$)/;

const pick = (text, pattern) => text.match(pattern)?.[1];

// What the launch was asked to do: its task file, or its longest quoted prompt.
export function taskOf(command) {
  const file = command.match(/<\s*["']?([^\s"'<>|;&]+)["']?/)?.[1];
  if (file && file !== '/dev/null') return `task file ${file.split('/').pop().replace(/^\$\{?(\w+)\}?$/, '$$$1')}`;
  const quoted = [...command.matchAll(/"((?:[^"\\]|\\.){12,})"|'([^']{12,})'/g)]
    .map((match) => (match[1] ?? match[2]).replace(/\\"/g, '"').replace(/\s+/g, ' ').trim())
    .filter((text) => !/^-|^[\w."@-]+=|\$\{|model_reasoning_effort|sandbox_mode|^plugins\./.test(text));
  const prompt = quoted.sort((a, b) => b.length - a.length)[0];
  return prompt ? (prompt.length > 140 ? `${prompt.slice(0, 139)}…` : prompt) : null;
}

export function parseCodexCommand(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(CODEX_EXEC);
  if (!match || HELP.test(match[1])) return null;
  return {
    model: pick(command, /(?:^|\s)(?:-m|--model)[\s=]+["']?([\w.\-]+)/),
    effort: pick(command, /model_reasoning_effort\s*=\s*\\?["']?(\w+)/),
    sandbox:
      pick(command, /(?:^|\s)(?:-s|--sandbox)[\s=]+["']?([\w-]+)/) ??
      pick(command, /sandbox_mode\s*=\s*\\?["']?([\w-]+)/),
    worktree: /\s--worktree\b/.test(command),
    review: /^\s*review\b/.test(match[1]),
    dangerous: /--dangerously-bypass-approvals-and-sandbox/.test(command),
    directory: pick(command, /(?:^|\s)(?:-C|--cd)[\s=]+["']?([^\s"']+)/),
    task: taskOf(command.slice(match.index)),
  };
}

export function parseClaudeCommand(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(CLAUDE_CLI);
  if (!match || !/(?:^|\s)(?:-p|--print)\b/.test(match[1]) || HELP.test(match[1])) return null;
  return {
    model: pick(command, /--model[\s=]+["']?([\w.\-]+)/),
    effort: pick(command, /--effort[\s=]+["']?(\w+)/),
    permissionMode: pick(command, /--permission-mode[\s=]+["']?([\w-]+)/),
    dangerous: /--dangerously-skip-permissions/.test(command),
    task: taskOf(command.slice(match.index)),
  };
}

// Codex records shell calls as tool-call payloads; returns the shell command strings inside.
export function shellCommandsOf(payload) {
  const raw = payload.input ?? payload.arguments ?? payload.action;
  if (raw == null) return [];
  if (typeof raw === 'object') return [raw.command, raw.cmd].flat().filter((value) => typeof value === 'string');
  try {
    const parsed = JSON.parse(raw);
    return [parsed.cmd, parsed.command].flat().filter((value) => typeof value === 'string');
  } catch {}
  // Code-mode calls look like: tools.exec_command({cmd:"...", ...}).
  const commands = [];
  for (const match of raw.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      commands.push(JSON.parse(match[1]));
    } catch {}
  }
  return commands;
}
