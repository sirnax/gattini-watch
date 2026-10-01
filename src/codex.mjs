import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonlTail } from './jsonl.mjs';
import { parseClaudeCommand, shellCommandsOf } from './commands.mjs';

// Reads Codex rollout logs: <root>/sessions/YYYY/MM/DD/rollout-*.jsonl. Sessions started
// with --ephemeral write no log and cannot appear here.

const DAY_MS = 24 * 60 * 60 * 1000;

function init() {
  return {
    id: null,
    cwd: null,
    originator: null,
    source: null,
    threadSource: null,
    parentThreadId: null,
    nickname: null,
    role: null,
    title: null,
    model: null,
    effort: null,
    sandbox: null,
    startedAt: null,
    lastAt: null,
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsAborted: 0,
    error: null,
    tokens: 0,
    lastAction: null,
    claudeCalls: [],
  };
}

// The VS Code extension prefixes the request with IDE context; keep only the request.
const IDE_REQUEST = /## My request for Codex:\s*/;

function requestText(text) {
  if (typeof text !== 'string') return null;
  let value = text;
  const marker = value.match(IDE_REQUEST);
  if (marker) value = value.slice(marker.index + marker[0].length);
  value = value.trim();
  if (!value || value.startsWith('<') || value.startsWith('# AGENTS.md') || value.startsWith('# Context from my IDE') || value.startsWith('[Request interrupted')) return null;
  return value.slice(0, 200);
}

function reduce(state, record) {
  const at = record.timestamp ? Date.parse(record.timestamp) : null;
  if (at) {
    state.startedAt ??= at;
    state.lastAt = at;
  }
  const payload = record.payload ?? {};

  if (record.type === 'session_meta') {
    state.id = payload.id ?? state.id;
    state.cwd = payload.cwd ?? state.cwd;
    state.originator = payload.originator ?? null;
    state.source = typeof payload.source === 'string' ? payload.source : payload.source?.subagent ? 'subagent' : null;
    state.threadSource = payload.thread_source ?? null;
    state.parentThreadId = payload.parent_thread_id ?? null;
    state.nickname = payload.agent_nickname ?? null;
    state.role = payload.agent_role ?? null;
    if (payload.timestamp) state.startedAt = Date.parse(payload.timestamp);
  } else if (record.type === 'turn_context') {
    state.model = payload.model ?? state.model;
    state.effort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? state.effort;
    state.sandbox = payload.sandbox_policy?.type ?? state.sandbox;
    state.cwd ??= payload.cwd;
  } else if (record.type === 'event_msg') {
    if (payload.type === 'task_started') state.turnsStarted += 1;
    else if (payload.type === 'task_complete') state.turnsCompleted += 1;
    else if (payload.type === 'turn_aborted') state.turnsAborted += 1;
    else if (payload.type === 'error') state.error = String(payload.message ?? 'error').slice(0, 200);
    else if (payload.type === 'token_count') state.tokens = payload.info?.total_token_usage?.total_tokens ?? state.tokens;
  } else if (record.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'user' && !state.title) {
      const title = (payload.content ?? []).map((part) => requestText(part?.text)).find(Boolean);
      if (title) state.title = title;
    } else if (payload.type === 'custom_tool_call' || payload.type === 'function_call' || payload.type === 'local_shell_call') {
      const commands = shellCommandsOf(payload);
      const shown = commands.find((command) => !/^(?:bash|zsh|sh|-l?c)$/.test(command)) ?? payload.name ?? payload.type;
      state.lastAction = shown.split('\n')[0].slice(0, 80);
      for (const command of commands) {
        const parsed = parseClaudeCommand(command);
        if (parsed) state.claudeCalls.push({ id: `${payload.call_id ?? payload.id}:${state.claudeCalls.length}`, at, ...parsed });
      }
    }
  }
}

function mergeParts(a, b) {
  const [early, late] = (a.startedAt ?? 0) <= (b.startedAt ?? 0) ? [a, b] : [b, a];
  return {
    ...early,
    model: late.model ?? early.model,
    effort: late.effort ?? early.effort,
    sandbox: late.sandbox ?? early.sandbox,
    title: early.title ?? late.title,
    lastAt: Math.max(early.lastAt ?? 0, late.lastAt ?? 0),
    mtimeMs: Math.max(early.mtimeMs, late.mtimeMs),
    turnsStarted: early.turnsStarted + late.turnsStarted,
    turnsCompleted: early.turnsCompleted + late.turnsCompleted,
    turnsAborted: early.turnsAborted + late.turnsAborted,
    error: late.error ?? early.error,
    tokens: Math.max(early.tokens, late.tokens),
    lastAction: late.lastAction ?? early.lastAction,
    claudeCalls: [...early.claudeCalls, ...late.claudeCalls],
  };
}

async function listDir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export function createCodexReader(root) {
  const tail = new JsonlTail({ init, reduce });

  async function listFiles(sinceMs) {
    const sessionsDir = join(root, 'sessions');
    // Day folders are named by local start date; a session can run past midnight.
    const earliest = new Date(sinceMs - 2 * DAY_MS);
    const floor = earliest.getFullYear() * 10000 + (earliest.getMonth() + 1) * 100 + earliest.getDate();
    const files = [];
    for (const year of await listDir(sessionsDir)) {
      for (const month of await listDir(join(sessionsDir, year))) {
        for (const day of await listDir(join(sessionsDir, year, month))) {
          if (Number(year) * 10000 + Number(month) * 100 + Number(day) < floor) continue;
          const dir = join(sessionsDir, year, month, day);
          for (const name of await listDir(dir)) {
            if (!name.endsWith('.jsonl')) continue;
            const path = join(dir, name);
            const info = await stat(path).catch(() => null);
            if (info && info.mtimeMs >= sinceMs) files.push(path);
          }
        }
      }
    }
    return files;
  }

  async function read(sinceMs) {
    const files = await listFiles(sinceMs);
    tail.retain(files);
    // One session can span several rollout files (e.g. after a resume); merge them by id.
    const sessions = new Map();
    for (const path of files) {
      const { state, mtimeMs } = await tail.read(path).catch(() => ({}));
      if (!state?.id) continue;
      const part = { mtimeMs, ...state };
      const seen = sessions.get(state.id);
      sessions.set(state.id, seen ? mergeParts(seen, part) : part);
    }
    return { sessions: [...sessions.values()] };
  }

  return { read };
}
