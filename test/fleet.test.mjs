import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleet, projectName } from '../src/fleet.mjs';
import { parseCodexCommand, parseClaudeCommand, shellCommandsOf } from '../src/commands.mjs';
import { JsonlTail } from '../src/jsonl.mjs';
import { allowedHost, startServer } from '../src/server.mjs';
import { request } from 'node:http';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const iso = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gattini-watch-'));
  const claudeRoot = join(root, 'claude');
  const codexRoot = join(root, 'codex');
  const repo = '/work/teacake';
  const beaver = '/work/block-beaver';

  // Claude session in teacake: launches one subagent and one codex exec review.
  const projectDir = join(claudeRoot, 'projects', '-work-teacake');
  await mkdir(join(projectDir, 'sess-1', 'subagents'), { recursive: true });
  await writeFile(join(projectDir, 'sess-1.jsonl'), jsonl([
    { type: 'ai-title', aiTitle: 'Review branch' },
    { type: 'user', timestamp: iso(0), cwd: repo, entrypoint: 'claude-vscode', message: { role: 'user', content: 'Please review' } },
    {
      type: 'assistant', timestamp: iso(5), cwd: repo, effort: 'high',
      message: {
        model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { output_tokens: 40 },
        content: [
          { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Explore code', subagent_type: 'Explore' } },
          { type: 'tool_use', id: 'toolu_codex', name: 'Bash', input: { run_in_background: true, command: 'cd /work/teacake && codex exec -m gpt-6.1-sol -c model_reasoning_effort="xhigh" -s read-only -o out.md "review" < /dev/null' } },
          { type: 'tool_use', id: 'toolu_help', name: 'Bash', input: { command: 'codex exec --help; grep -n "codex exec" CLAUDE.md' } },
          { type: 'tool_use', id: 'toolu_lost', name: 'Bash', input: { command: 'codex exec --ephemeral -s read-only "x"' } },
        ],
      },
    },
  ]));
  await writeFile(join(projectDir, 'sess-1', 'subagents', 'agent-a1.jsonl'), jsonl([
    { type: 'user', timestamp: iso(6), cwd: repo, message: { role: 'user', content: 'Find the router' } },
    { type: 'assistant', timestamp: iso(30), cwd: repo, message: { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', usage: { output_tokens: 12 }, content: [{ type: 'text', text: 'Found it' }] } },
  ]));
  await writeFile(join(projectDir, 'sess-1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Explore code', toolUseId: 'toolu_agent' }));

  // Headless Claude worker launched by Codex in block-beaver.
  const beaverDir = join(claudeRoot, 'projects', '-work-block-beaver');
  await mkdir(beaverDir, { recursive: true });
  await writeFile(join(beaverDir, 'worker-1.jsonl'), jsonl([
    { type: 'user', timestamp: iso(104), cwd: beaver, entrypoint: 'sdk-cli', message: { role: 'user', content: 'Review sub-project A' } },
    { type: 'assistant', timestamp: iso(150), cwd: beaver, effort: 'high', message: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { output_tokens: 99 }, content: [{ type: 'text', text: 'Done' }] } },
  ]));

  const day = join(codexRoot, 'sessions', '2026', '10', '01');
  await mkdir(day, { recursive: true });
  // Codex exec worker launched by the Claude session (starts 3s after the call).
  await writeFile(join(day, 'rollout-a.jsonl'), jsonl([
    { timestamp: iso(8), type: 'session_meta', payload: { id: 'cx-exec', timestamp: iso(8), cwd: repo, originator: 'codex_exec', source: 'exec', thread_source: 'user' } },
    { timestamp: iso(8), type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'xhigh', sandbox_policy: { type: 'read-only' } } },
    { timestamp: iso(8), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(9), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }, { type: 'input_text', text: 'review the diff' }] } },
    { timestamp: iso(90), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5000 } } } },
    { timestamp: iso(91), type: 'event_msg', payload: { type: 'task_complete' } },
  ]));
  // Interactive Codex session in block-beaver that launches claude -p. Like real logs, it
  // gains a later copy of a header from another thread, which must not change its identity.
  const mainMeta = { id: 'cx-main', timestamp: iso(60), cwd: beaver, originator: 'codex_vscode', source: 'vscode', thread_source: 'user' };
  const mainHistory = [
    { timestamp: iso(60), type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'medium', sandbox_policy: { type: 'workspace-write' } } },
    { timestamp: iso(60), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## My request for Codex:\nShip sub-project A' }] } },
    { timestamp: iso(61), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(100), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'text(await tools.exec_command({cmd:"cd /tmp/w && claude -p --model claude-sonnet-5-5 --effort high < task.txt"}));' } },
  ];
  const spawnMeta = (id, parent, nickname, path, depth, at) => ({
    timestamp: iso(at), type: 'session_meta',
    payload: { id, timestamp: iso(at), cwd: beaver, originator: 'codex_vscode', source: { subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: path, agent_nickname: nickname, agent_role: null } } }, thread_source: 'subagent' },
  });
  const ownThread = (at, task) => [
    { timestamp: iso(at), type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    { timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(at), type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: task.path, content: [{ type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${task.path}\nSender: /root\nPayload:\n${task.text ?? ''}` }] } },
    { timestamp: iso(at + 1), type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high', sandbox_policy: { type: 'workspace-write' } } },
    { timestamp: iso(at + 5), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 700 } } } },
    { timestamp: iso(at + 6), type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  await writeFile(join(day, 'rollout-b1.jsonl'), jsonl([
    { timestamp: iso(60), type: 'session_meta', payload: mainMeta },
    ...mainHistory,
    { timestamp: iso(150), type: 'session_meta', payload: { ...mainMeta, id: 'cx-other', timestamp: iso(150) } },
    { timestamp: iso(151), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9000 } } } },
    { timestamp: iso(201), type: 'event_msg', payload: { type: 'task_complete' } },
  ]));
  // Spawned subagent: its own header, then its parent's, then a copy of the parent's
  // conversation (with an unmatched task_started) before its own thread begins.
  await writeFile(join(day, 'rollout-s1.jsonl'), jsonl([
    spawnMeta('cx-volta', 'cx-main', 'Volta', '/root/scanner', 1, 110),
    { timestamp: iso(110), type: 'session_meta', payload: mainMeta },
    ...mainHistory,
    ...ownThread(111, { path: '/root/scanner' }),
  ]));
  // Nested spawn two levels down, carrying both ancestors' headers; its task is readable.
  await writeFile(join(day, 'rollout-s2.jsonl'), jsonl([
    spawnMeta('cx-kepler', 'cx-volta', 'Kepler', '/root/scanner/check', 2, 120),
    spawnMeta('cx-volta', 'cx-main', 'Volta', '/root/scanner', 1, 110),
    { timestamp: iso(110), type: 'session_meta', payload: mainMeta },
    ...mainHistory,
    ...ownThread(121, { path: '/root/scanner/check', text: 'Check the scanner output' }),
  ]));
  // Guardian review subagent of the Codex session.
  await writeFile(join(day, 'rollout-c.jsonl'), jsonl([
    { timestamp: iso(70), type: 'session_meta', payload: { id: 'cx-guard', timestamp: iso(70), cwd: beaver, originator: 'codex_vscode', source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', parent_thread_id: 'cx-main' } },
    { timestamp: iso(70), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(72), type: 'event_msg', payload: { type: 'task_complete' } },
  ]));

  return { root, claudeRoot, codexRoot };
}

test('parses real launches and ignores help probes and quoted mentions', () => {
  const review = parseCodexCommand('cd x && codex exec "${no_deploy[@]}" -m gpt-6.1-sol -c model_reasoning_effort="xhigh" -s read-only -o r.md "go" < /dev/null');
  assert.deepEqual([review.model, review.effort, review.sandbox, review.worktree], ['gpt-6.1-sol', 'xhigh', 'read-only', false]);
  assert.equal(parseCodexCommand('codex exec review --base main').review, true);
  assert.equal(parseCodexCommand('codex exec --worktree -s workspace-write - < t.md').worktree, true);
  assert.equal(parseCodexCommand('codex exec --help'), null);
  assert.equal(parseCodexCommand('grep -n "codex exec" CLAUDE.md'), null);
  assert.equal(parseCodexCommand('codex --version'), null);
  assert.equal(parseClaudeCommand('claude -p --model claude-opus-5-5 --effort xhigh < t').effort, 'xhigh');
  assert.equal(parseClaudeCommand('claude --version'), null);
  assert.equal(parseClaudeCommand('echo "claude -p"'), null);
  assert.equal(parseClaudeCommand('cd w && claude -p --model x < "$task_file"').task, 'task file $task_file');
  assert.equal(
    parseCodexCommand(`codex exec -c 'plugins."vercel@x".enabled=false' -s read-only "Review the diff against AGENTS.md please" < /dev/null`).task,
    'Review the diff against AGENTS.md please',
  );
  assert.deepEqual(shellCommandsOf({ arguments: JSON.stringify({ command: ['bash', '-lc', 'claude -p x'] }) }), ['bash', '-lc', 'claude -p x']);
});

test('builds the cross-tool tree with statuses', async () => {
  const { root, claudeRoot, codexRoot } = await fixture();
  try {
    const snapshot = await createFleet({ claudeRoot, codexRoot }).snapshot({ hours: 24 * 365 * 10, now: T0 + 300_000 });
    const teacake = snapshot.projects.find((project) => project.name === 'teacake');
    const beaver = snapshot.projects.find((project) => project.name === 'block-beaver');

    assert.equal(teacake.nodes.length, 1, 'codex worker nests under the Claude session');
    const session = teacake.nodes[0];
    assert.equal(session.title, 'Review branch');
    assert.equal(session.model, 'claude-opus-5-5');
    const kinds = session.children.map((child) => `${child.tool}/${child.kind}/${child.status}`).sort();
    assert.deepEqual(kinds, ['claude/subagent/done', 'codex/worker/done', 'codex/worker/unlogged']);
    const worker = session.children.find((child) => child.status === 'done' && child.tool === 'codex');
    assert.equal(worker.effort, 'xhigh');
    assert.equal(worker.title, 'review the diff');
    assert.equal(worker.tokens, 5000);

    assert.equal(beaver.nodes.length, 1, 'later headers do not split or rename the session');
    const main = beaver.nodes[0];
    assert.equal(main.key, 'codex:cx-main');
    assert.equal(main.title, 'Ship sub-project A');
    assert.equal(main.status, 'idle');
    assert.equal(main.tokens, 9000);
    const children = main.children.map((child) => `${child.tool}/${child.kind}/${child.title}`).sort();
    assert.deepEqual(children, ['claude/worker/Review sub-project A', 'codex/subagent/Guardian review', 'codex/subagent/Volta · scanner']);

    // Spawned subagents keep their own identity and ignore the inherited conversation.
    const volta = main.children.find((child) => child.key === 'codex:cx-volta');
    assert.equal(volta.status, 'done', 'the inherited task_started does not leave it running');
    assert.equal(volta.tokens, 700);
    assert.equal(volta.effort, 'high');
    assert.equal(volta.children.length, 1);
    const kepler = volta.children[0];
    assert.equal(kepler.key, 'codex:cx-kepler');
    assert.equal(kepler.title, 'Check the scanner output');
    assert.equal(kepler.status, 'done');
    assert.ok(kepler.tags.includes('scanner/check'));
    assert.equal(main.children.filter((child) => child.tool === 'claude').length, 1, 'inherited launches are not counted again');

    // The Claude session's last turn ended on a tool call, so it is still running.
    assert.equal(session.status, 'running');
    assert.deepEqual(snapshot.counts, { claude: { running: 1, total: 3 }, codex: { running: 0, total: 6 } }, 'five logs plus one unlogged launch');
    assert.deepEqual(snapshot.audit.codex, { read: 5, shown: 5, missing: [] });
    assert.deepEqual(snapshot.audit.claude, { read: 3, shown: 3, missing: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reads appended lines incrementally, including a line split across writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gattini-watch-tail-'));
  const path = join(root, 'log.jsonl');
  try {
    const tail = new JsonlTail({ init: () => ({ seen: [] }), reduce: (state, record) => state.seen.push(record.n) });
    await writeFile(path, '{"n":1}\n{"n":');
    assert.deepEqual((await tail.read(path)).state.seen, [1]);
    await appendFile(path, '2}\n{"n":3}\n');
    assert.deepEqual((await tail.read(path)).state.seen, [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('groups worktrees under their repository', () => {
  assert.equal(projectName('/work/teacake/.claude/worktrees/feature-x'), 'teacake');
  assert.equal(projectName('/Users/me/.codex/worktrees/abc/teacake'), 'teacake');
});

test('answers loopback names only, and refuses a busy port instead of moving', async () => {
  for (const host of ['gattini-watch.localhost:4777', 'localhost', '127.0.0.1:9', '[::1]:4777', 'GATTINI-WATCH.LOCALHOST']) assert.ok(allowedHost(host), host);
  for (const host of ['evil.example', 'evil.example:4777', 'localhost.evil.example', '192.168.1.5:4777', undefined]) assert.ok(!allowedHost(host), String(host));

  const fleet = { snapshot: async () => ({ ok: true }) };
  const server = await startServer({ fleet, port: 0, hours: 1 });
  try {
    const url = `http://127.0.0.1:${server.port}/api/snapshot`;
    assert.equal((await fetch(url)).status, 200);
    const foreign = await new Promise((resolve, reject) => {
      request(url, { headers: { host: 'evil.example' } }, (response) => resolve(response.statusCode)).on('error', reject).end();
    });
    assert.equal(foreign, 403);
    await assert.rejects(startServer({ fleet, port: server.port, hours: 1 }), { code: 'EADDRINUSE' });
  } finally {
    await server.close();
  }
});
