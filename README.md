# agent-fleet

A live local dashboard of every Claude Code and Codex agent on this machine. It shows
which sessions are running, the subagents they spawned, and the workers each tool launched
in the other: Claude running `codex exec`, or Codex running `claude -p`.

```sh
node bin/agent-fleet.mjs --open        # or: npm start
```

It opens on `http://127.0.0.1:4777`. There are no dependencies, but it needs Node 22 or later.

| Option | Default | Meaning |
| --- | --- | --- |
| `--port` | 4777 | Port, bound to 127.0.0.1 only |
| `--hours` | 6 | How far back finished agents stay visible (the page can change it) |
| `--open` | off | Open the browser |
| `--json` | off | Print one snapshot and exit |

To run it from anywhere, use `npm link` in this folder, then `agent-fleet --open`.

## Views

- **Tree**: one row for each agent, with model, effort, sandbox, status, duration and tokens. Workers and subagents are nested under whatever launched them.
- **Blocks**: one card for each top-level session, with a small square for each of its workers. Claude squares are orange and Codex squares green. Faded means finished, striped means stale, dashed means unlogged, and a pulsing square is running.

You can sort by newest first, oldest first or status, and filter by project. You can also hide finished agents or Codex's guardian reviews.

## Where the data comes from

It only reads logs that the tools already write. Nothing is changed, and nothing leaves the machine.

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl`, plus `<session>/subagents/`. Set `CLAUDE_CONFIG_DIR` if your logs are elsewhere.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Set `CODEX_HOME` if yours are elsewhere.

Neither tool records the other's session id. A worker is therefore linked to whoever launched it when the launch command and the new session match on time (the session starts within 3 minutes of the command) and on working folder.

Limitations:

- A Codex worker run with `--ephemeral` writes no log. It appears as **unlogged**, with only the details its launch command gives.
- Statuses are inferred from the logs. **Running** means a turn is open and the log changed in the last 10 minutes. **Stale** means a turn is open but nothing has been written for longer than that, so the session is probably killed or abandoned.
- The page shows the first line of prompts as titles. Keep the server on loopback.

## Development

```sh
npm test    # node --test, using fixture logs
```

The code is in `src/`. `jsonl.mjs` handles incremental log reading, `claude.mjs` and `codex.mjs` are the per-tool readers, `commands.mjs` detects launch commands, `fleet.mjs` builds the tree, and `server.mjs` handles HTTP and server-sent events. The page is in `public/`.
