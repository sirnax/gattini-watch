import { basename, join } from 'node:path';
import { createClaudeReader } from './claude.mjs';
import { createCodexReader } from './codex.mjs';

// Builds one tree of every agent active in the window:
//   Claude session -> Claude subagents (subagents/ folder) and Codex workers (`codex exec` calls)
//   Codex session  -> Codex subagents (parent_thread_id) and Claude workers (`claude -p` calls)
// Cross-tool links are matched on launch time and working folder, because neither tool
// records the other's session id.

const ACTIVE_MS = 10 * 60 * 1000;
const LINK_BEFORE_MS = 15 * 1000;
const LINK_AFTER_MS = 3 * 60 * 1000;

const ORIGINATORS = { codex_vscode: 'vscode', codex_exec: 'exec', 'codex-tui': 'cli', 'Codex Desktop': 'desktop' };

const ENTRYPOINTS = { 'claude-vscode': 'vscode', cli: 'cli', 'sdk-cli': 'headless', 'claude-desktop': 'desktop', 'sdk-py': 'sdk' };

const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];

function isScratch(cwd) {
  return Boolean(cwd) && (TEMP_ROOTS.some((root) => cwd.startsWith(root)) || cwd.includes('/.codex/worktrees/'));
}

// Folds scratch folders such as /tmp/block-beaver-sonnet-host into the known project they name.
function owningProject(cwd, known) {
  const segments = cwd.split('/');
  let best = null;
  for (const name of known) {
    if (segments.some((segment) => segment === name || segment.startsWith(`${name}-`)) && (!best || name.length > best.length)) best = name;
  }
  return best;
}

// Review and Build come from launch flags; otherwise the task wording is the best hint.
function roleFrom({ call, sandbox, title }) {
  if (call?.review || call?.sandbox === 'read-only') return 'review';
  if (call?.worktree || call?.sandbox === 'workspace-write') return 'build';
  if (/\b(review|audit|verify|inspect)/i.test(title ?? '')) return 'review';
  if (/\b(implement|fix|build|refactor|write|update)/i.test(title ?? '')) return 'build';
  if (sandbox === 'read-only') return 'review';
  return null;
}

export function projectName(cwd) {
  if (!cwd) return 'unknown';
  const claudeWorktree = cwd.match(/^(.*?)\/\.claude\/worktrees\//);
  if (claudeWorktree) return basename(claudeWorktree[1]);
  return basename(cwd);
}

function claudeStatus(state, now, finishedLabel) {
  if (state.lastType === 'assistant' && state.lastStop === 'end_turn') return finishedLabel;
  return now - state.mtimeMs < ACTIVE_MS ? 'running' : 'stale';
}

function codexStatus(state, now) {
  const open = state.turnsStarted - state.turnsCompleted - state.turnsAborted;
  if (open > 0 || state.turnsStarted === 0) return now - state.mtimeMs < ACTIVE_MS ? 'running' : 'stale';
  if (state.error && state.turnsCompleted === 0) return 'failed';
  if (state.turnsAborted > 0 && state.turnsCompleted === 0) return 'failed';
  return state.originator === 'codex_exec' || state.source === 'subagent' ? 'done' : 'idle';
}

function claudeNode(session, now) {
  const headless = session.entrypoint === 'sdk-cli';
  return {
    key: `claude:${session.id}`,
    tool: 'claude',
    kind: headless ? 'worker' : 'session',
    title: session.title || session.prompt || session.id.slice(0, 8),
    cwd: session.cwd,
    model: session.model,
    effort: session.effort,
    status: claudeStatus(session, now, headless ? 'done' : 'idle'),
    startedAt: session.startedAt,
    lastAt: session.lastAt ?? session.mtimeMs,
    tokens: session.outputTokens,
    tokensLabel: 'output',
    activity: session.lastAction,
    role: headless ? roleFrom({ title: session.title || session.prompt }) : null,
    tags: [ENTRYPOINTS[session.entrypoint] ?? session.entrypoint].filter(Boolean),
    warnings: [],
    children: [],
  };
}

function subagentNode(agent, now) {
  return {
    key: `claude-agent:${agent.sessionId}:${agent.id}`,
    tool: 'claude',
    kind: 'subagent',
    title: agent.meta.description || agent.prompt || agent.id,
    cwd: agent.cwd,
    model: agent.model,
    effort: agent.effort,
    status: claudeStatus(agent, now, 'done'),
    startedAt: agent.startedAt,
    lastAt: agent.lastAt ?? agent.mtimeMs,
    tokens: agent.outputTokens,
    tokensLabel: 'output',
    activity: agent.lastAction,
    role: agent.meta.agentType ? agent.meta.agentType.toLowerCase() : null,
    tags: [agent.meta.agentType, agent.meta.requestShape === 'background' ? 'background' : null].filter(Boolean),
    warnings: [],
    children: [],
  };
}

// "Volta · scanner" from the spawn record when the task itself is not readable.
function spawnName(session) {
  const path = session.agentPath?.split('/').filter(Boolean).slice(1).join('/');
  return [session.nickname, path].filter(Boolean).join(' · ') || null;
}

function codexNode(session, now, codexRoot) {
  const guardian = session.threadSource === 'guardian_review';
  const kind = session.source === 'subagent' ? 'subagent' : session.originator === 'codex_exec' ? 'worker' : 'session';
  const tags = [];
  if (kind !== 'subagent' && session.originator) tags.push(ORIGINATORS[session.originator] ?? session.originator);
  if (guardian) tags.push('guardian');
  if (session.agentPath) tags.push(session.agentPath.replace(/^\/root\/?/, '') || 'root');
  if (session.role) tags.push(session.role);
  if (session.sandbox) tags.push(session.sandbox);
  if (session.cwd?.startsWith(join(codexRoot, 'worktrees'))) tags.push('worktree');
  return {
    key: `codex:${session.id}`,
    path: session.path,
    tool: 'codex',
    kind,
    guardian,
    title: (guardian ? 'Guardian review' : null) || session.title || spawnName(session) || session.id.slice(0, 8),
    cwd: session.cwd,
    model: session.model,
    effort: session.effort,
    status: codexStatus(session, now),
    startedAt: session.startedAt,
    lastAt: session.lastAt ?? session.mtimeMs,
    tokens: session.tokens,
    tokensLabel: 'total',
    activity: session.lastAction,
    role: guardian ? 'guard' : kind === 'session' ? null : session.role ?? roleFrom({ sandbox: session.sandbox, title: session.title }),
    tags,
    warnings: session.error ? [session.error] : [],
    children: [],
  };
}

function unloggedNode(key, tool, call, parentCwd) {
  return {
    key,
    tool,
    kind: 'worker',
    title: call.description || call.task || (tool === 'codex' ? (call.review ? 'codex exec review' : 'codex exec') : 'claude -p'),
    cwd: parentCwd,
    model: call.model ?? null,
    effort: call.effort ?? null,
    status: 'unlogged',
    startedAt: call.at,
    lastAt: call.at,
    tokens: null,
    activity: null,
    role: roleFrom({ call, title: call.description || call.task }),
    tags: [call.sandbox, call.worktree ? 'worktree' : null, call.background ? 'background' : null].filter(Boolean),
    note: 'Launch seen, but no log matched: run with --ephemeral, failed at startup, or started outside the window.',
    warnings: [],
    children: [],
  };
}

function cwdRelated(child, parent, codexRoot) {
  if (!child || !parent) return false;
  return child === parent || child.startsWith(`${parent}/`) || child.startsWith(join(codexRoot, 'worktrees')) || projectName(child) === projectName(parent);
}

// Pairs each launch with the closest unclaimed session that started just after it.
function matchLaunch(call, candidates, claimed, isRelated) {
  let best = null;
  for (const candidate of candidates) {
    if (claimed.has(candidate.key) || !candidate.startedAt || !call.at) continue;
    const delta = candidate.startedAt - call.at;
    if (delta < -LINK_BEFORE_MS || delta > LINK_AFTER_MS) continue;
    const score = (isRelated(candidate) ? 0 : 1) * LINK_AFTER_MS * 10 + Math.abs(delta);
    if (!best || score < best.score) best = { candidate, score };
  }
  if (best) claimed.add(best.candidate.key);
  return best?.candidate ?? null;
}

function sortTree(nodes, byRecency) {
  const rank = { running: 0, stale: 1, unlogged: 2, failed: 2, idle: 3, done: 4 };
  nodes.sort(byRecency ? (a, b) => (rank[a.status] - rank[b.status]) || (b.lastAt - a.lastAt) : (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  for (const node of nodes) sortTree(node.children, false);
  return nodes;
}

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

// Every log read should appear exactly once in the tree; anything else is reported.
function auditOf(byTool, shown, fileCounts) {
  const audit = {};
  for (const [tool, entries] of Object.entries(byTool)) {
    const missing = entries.filter(({ node }) => !shown.has(node.key)).map(({ session, node }) => ({ key: node.key, path: session.path ?? null }));
    audit[tool] = { read: fileCounts[tool] ?? entries.length, shown: entries.length - missing.length, missing };
  }
  return audit;
}

export function createFleet({ claudeRoot, codexRoot }) {
  const claude = createClaudeReader(claudeRoot);
  const codex = createCodexReader(codexRoot);

  async function snapshot({ hours = 6, now = Date.now() } = {}) {
    const sinceMs = now - hours * 60 * 60 * 1000;
    const [{ sessions: claudeSessions, subagents }, { sessions: codexSessions, files: codexFiles }] = await Promise.all([claude.read(sinceMs), codex.read(sinceMs)]);

    const claudeNodes = new Map(claudeSessions.map((session) => [session.id, { session, node: claudeNode(session, now) }]));
    const codexNodes = new Map();
    for (const session of codexSessions) {
      const node = codexNode(session, now, codexRoot);
      // Two logs claiming one id would hide one of them; keep both and let the audit show it.
      const id = codexNodes.has(session.id) ? `${session.id}#${session.path}` : session.id;
      if (id !== session.id) node.key = `codex:${id}`;
      codexNodes.set(id, { session, node });
    }
    const attached = new Set();
    const claimed = new Set();

    const claudeEntries = [...claudeNodes.values()];
    for (const agent of subagents) {
      const node = subagentNode(agent, now);
      claudeEntries.push({ session: agent, node });
      const parent = claudeNodes.get(agent.sessionId);
      if (parent) parent.node.children.push(node);
      else claudeNodes.set(`orphan:${agent.id}`, { session: agent, node });
    }

    const execWorkers = [...codexNodes.values()].filter(({ session }) => session.originator === 'codex_exec').map(({ node }) => node);
    for (const { session, node } of claudeNodes.values()) {
      for (const call of session.codexCalls ?? []) {
        const worker = matchLaunch(call, execWorkers, claimed, (candidate) => cwdRelated(candidate.cwd, session.cwd, codexRoot) || candidate.cwd === call.directory);
        const child = worker ?? unloggedNode(`codex-call:${call.id}`, 'codex', call, session.cwd);
        if (worker) worker.role = roleFrom({ call }) ?? worker.role;
        if (call.dangerous) child.warnings.push('Launched with --dangerously-bypass-approvals-and-sandbox.');
        node.children.push(child);
        if (worker) attached.add(worker.key);
      }
    }

    const headlessClaude = [...claudeNodes.values()].filter(({ session }) => session.entrypoint === 'sdk-cli').map(({ node }) => node);
    for (const { session, node } of codexNodes.values()) {
      for (const call of session.claudeCalls) {
        const worker = matchLaunch(call, headlessClaude, claimed, (candidate) => cwdRelated(candidate.cwd, session.cwd, codexRoot));
        const child = worker ?? unloggedNode(`claude-call:${call.id}`, 'claude', call, session.cwd);
        if (call.dangerous) child.warnings.push('Launched with --dangerously-skip-permissions.');
        node.children.push(child);
        if (worker) attached.add(worker.key);
      }
      const parent = session.parentThreadId && codexNodes.get(session.parentThreadId);
      if (parent) {
        parent.node.children.push(node);
        attached.add(node.key);
      }
    }

    const roots = [...claudeNodes.values(), ...codexNodes.values()].map(({ node }) => node).filter((node) => !attached.has(node.key));
    const known = new Set(roots.filter((root) => root.cwd && !isScratch(root.cwd)).map((root) => projectName(root.cwd)));
    const projects = new Map();
    for (const root of roots) {
      const name = (isScratch(root.cwd) && owningProject(root.cwd, known)) || projectName(root.cwd);
      if (!projects.has(name)) projects.set(name, { name, nodes: [] });
      projects.get(name).nodes.push(root);
    }

    const counts = { claude: { running: 0, total: 0 }, codex: { running: 0, total: 0 } };
    const shown = new Set();
    walk(roots, (node) => {
      if (shown.has(node.key)) return;
      shown.add(node.key);
      counts[node.tool].total += 1;
      if (node.status === 'running') counts[node.tool].running += 1;
    });
    const audit = auditOf({ claude: claudeEntries, codex: [...codexNodes.values()] }, shown, { codex: codexFiles });

    const projectList = [...projects.values()].map((project) => ({ ...project, nodes: sortTree(project.nodes, true) }));
    const lastActivity = (project) => Math.max(...project.nodes.map((node) => node.lastAt ?? 0));
    projectList.sort((a, b) => lastActivity(b) - lastActivity(a));
    return { generatedAt: now, hours, counts, audit, projects: projectList };
  }

  return { snapshot };
}
