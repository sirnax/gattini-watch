#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { createFleet } from '../src/fleet.mjs';
import { startServer } from '../src/server.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_PORT = process.env.GATTINI_WATCH_PORT || '4777';

const USAGE = `Gattini Watch ${version}: live view of Claude Code and Codex agents on this machine

Usage: gattini-watch [--port 4777] [--hours 6] [--open] [--json]

  --port     Loopback port (default 4777, or GATTINI_WATCH_PORT)
  --hours    How far back to show finished agents (default 6)
  --open     Open the dashboard in the default browser
  --json     Print one snapshot as JSON and exit
  --version  Print the version and exit

Address: http://gattini-watch.localhost:<port>
Log roots: CLAUDE_CONFIG_DIR (default ~/.claude), CODEX_HOME (default ~/.codex).`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: DEFAULT_PORT },
    hours: { type: 'string', default: '6' },
    open: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

if (values.version) {
  console.log(version);
  process.exit(0);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const hours = Number(values.hours);
const port = Number(values.port);
if (!(hours > 0) || !Number.isInteger(port) || port < 1 || port > 65535) {
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
  // A clean exit: the Homebrew service restarts only after a crash, so a stop stays stopped.
  const onStop = () => {
    console.log('Stopped from the page.');
    process.exit(0);
  };
  await startServer({ fleet, port, hours, onStop });
} catch (error) {
  // Never move to another port by itself: a changing address breaks bookmarks and services.
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Choose another with --port <n> or GATTINI_WATCH_PORT=<n>.`
      : error.message,
  );
  process.exit(1);
}

const url = `http://gattini-watch.localhost:${port}/`;
console.log(`Gattini Watch is running at ${url} (Ctrl+C to stop)`);
if (values.open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
