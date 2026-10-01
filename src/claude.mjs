import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { JsonlTail } from './jsonl.mjs';
import { parseCodexCommand } from './commands.mjs';

// Reads Claude Code's per-project logs: <root>/projects/<project>/<session>.jsonl, plus
// <session>/subagents/agent-<id>.jsonl and .meta.json for each subagent it launched.

const AGENT_TOOLS = new Set(['Agent', 'Task']);

function init() {
  return {
    cwd: null,
    title: null,
    prompt: null,
    model: null,
    effort: null,
    entrypoint: null,
    startedAt: null,
    lastAt: null,
    lastType: null,
    lastStop: null,
    outputTokens: 0,
    lastAction: null,
    agentCalls: [],
    codexCalls: [],
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const part = content.find((item) => item?.type === 'text' && typeof item.text === 'string');
  return part?.text ?? null;
}

const clip = (text, length = 80) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// One readable line for the agent's latest tool call.
function describeTool(name, input) {
  const file = (path) => (typeof path === 'string' ? basename(path) : '');
  if (name === 'Bash') return clip(input.description || String(input.command ?? '').split('\n')[0]);
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return `${name} ${file(input.file_path ?? input.notebook_path)}`;
  if (name === 'Grep' || name === 'Glob') return clip(`${name} ${input.pattern ?? ''}`);
  if (AGENT_TOOLS.has(name)) return clip(`Agent: ${input.description ?? ''}`);
  if (name === 'WebFetch' || name === 'WebSearch') return clip(`${name} ${input.url ?? input.query ?? ''}`);
  return clip(name.replace(/^mcp__[^_]+__/, ''));
}

function reduce(state, record) {
  const at = record.timestamp ? Date.parse(record.timestamp) : null;
  if (at) {
    state.startedAt ??= at;
    state.lastAt = at;
  }
  if (record.cwd) state.cwd ??= record.cwd;
  if (record.entrypoint) state.entrypoint ??= record.entrypoint;
  if (record.type === 'ai-title' && record.aiTitle) state.title = record.aiTitle;

  if (record.type === 'user' && record.message) {
    state.lastType = 'user';
    const text = textOf(record.message.content);
    if (!state.prompt && text && !text.startsWith('<')) state.prompt = text.trim().slice(0, 200);
  }

  if (record.type === 'assistant' && record.message) {
    const { message } = record;
    state.lastType = 'assistant';
    if (message.model && message.model !== '<synthetic>') state.model = message.model;
    if (record.effort) state.effort = record.effort;
    if (message.stop_reason) state.lastStop = message.stop_reason;
    state.outputTokens += message.usage?.output_tokens ?? 0;
    for (const item of Array.isArray(message.content) ? message.content : []) {
      if (item?.type !== 'tool_use') continue;
      const input = item.input ?? {};
      state.lastAction = describeTool(item.name, input);
      if (AGENT_TOOLS.has(item.name)) {
        state.agentCalls.push({ id: item.id, at, description: input.description, agentType: input.subagent_type });
      } else if (item.name === 'Bash') {
        const parsed = parseCodexCommand(input.command);
        if (parsed) state.codexCalls.push({ id: item.id, at, background: Boolean(input.run_in_background), description: input.description ?? null, ...parsed });
      }
    }
  }
}

export function createClaudeReader(root) {
  const tail = new JsonlTail({ init, reduce });

  async function listFiles(sinceMs) {
    const projectsDir = join(root, 'projects');
    const files = [];
    let projects = [];
    try {
      projects = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(projectsDir, project.name);
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const path = join(dir, entry.name);
          const info = await stat(path).catch(() => null);
          if (info && info.mtimeMs >= sinceMs) files.push({ kind: 'session', path, sessionId: entry.name.slice(0, -6) });
        } else if (entry.isDirectory()) {
          const subDir = join(dir, entry.name, 'subagents');
          let agents = [];
          try {
            agents = await readdir(subDir);
          } catch {
            continue;
          }
          for (const name of agents) {
            if (!name.endsWith('.jsonl')) continue;
            const path = join(subDir, name);
            const info = await stat(path).catch(() => null);
            if (info && info.mtimeMs >= sinceMs) {
              files.push({ kind: 'subagent', path, sessionId: entry.name, agentId: name.slice(6, -6), metaPath: path.replace(/\.jsonl$/, '.meta.json') });
            }
          }
        }
      }
    }
    return files;
  }

  async function read(sinceMs) {
    const files = await listFiles(sinceMs);
    tail.retain(files.map((file) => file.path));
    const sessions = [];
    const subagents = [];
    for (const file of files) {
      const { state, mtimeMs } = await tail.read(file.path).catch(() => ({}));
      if (!state) continue;
      if (file.kind === 'session') {
        sessions.push({ id: file.sessionId, path: file.path, mtimeMs, ...state });
      } else {
        let meta = {};
        try {
          meta = JSON.parse(await readFile(file.metaPath, 'utf8'));
        } catch {}
        subagents.push({ id: file.agentId, sessionId: file.sessionId, path: file.path, mtimeMs, meta, ...state });
      }
    }
    return { sessions, subagents };
  }

  return { read };
}
