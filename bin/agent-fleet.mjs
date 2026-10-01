#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { createFleet } from '../src/fleet.mjs';
import { startServer } from '../src/server.mjs';

const USAGE = `agent-fleet: live view of Claude Code and Codex agents on this machine

Usage: agent-fleet [--port 4777] [--hours 6] [--open] [--json]

  --port   Port on 127.0.0.1 (default 4777)
  --hours  How far back to show finished agents (default 6)
  --open   Open the dashboard in the default browser
  --json   Print one snapshot as JSON and exit

Log roots: CLAUDE_CONFIG_DIR (default ~/.claude), CODEX_HOME (default ~/.codex).`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4777' },
    hours: { type: 'string', default: '6' },
    open: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const hours = Number(values.hours);
const port = Number(values.port);
if (!(hours > 0) || !Number.isInteger(port)) {
  console.error(USAGE);
  process.exit(2);
}

const fleet = createFleet({
  claudeRoot: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  codexRoot: process.env.CODEX_HOME || join(homedir(), '.codex'),
});

if (values.json) {
  console.log(JSON.stringify(await fleet.snapshot({ hours }), null, 2));
  process.exit(0);
}

try {
  await startServer({ fleet, port, hours });
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port ${port + 1}.` : error.message);
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/`;
console.log(`agent-fleet running at ${url} (Ctrl+C to stop)`);
if (values.open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
