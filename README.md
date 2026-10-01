# Gattini Watch

A live local dashboard of every Claude Code and Codex agent on your machine. It shows
which sessions are running, the subagents they spawned, and the workers each tool launched
in the other: Claude running `codex exec`, or Codex running `claude -p`.

Gattini Watch is a sibling of [Gattini](https://github.com/sirnax/gattini), the
local-first tool for coordinating agents. It works on its own and needs nothing from
Gattini.

## Install

```sh
brew install sirnax/gattini/gattini-watch
```

Keep it running, including after you log in:

```sh
brew services start gattini-watch
brew services stop gattini-watch      # to stop it
```

Or run it once in a terminal, and stop it with Ctrl+C:

```sh
gattini-watch --open
```

Then open **http://gattini-watch.localhost:4777**. Any name ending in `.localhost` reaches
your own machine on macOS, Linux and Windows, with no setup. `http://127.0.0.1:4777` also
works.

Update with `brew upgrade gattini-watch`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--port` | 4777, or `GATTINI_WATCH_PORT` | Port on the loopback addresses (127.0.0.1 and ::1) |
| `--hours` | 6 | How far back finished agents stay visible (the page can change it) |
| `--open` | off | Open the browser |
| `--json` | off | Print one snapshot and exit |
| `--version` | | Print the version |

If the port is taken, Gattini Watch stops and tells you, rather than quietly moving to
another one. Pick a free port with `--port` or `GATTINI_WATCH_PORT`. For the background
service, set the variable before `brew services start`.

### Without the port number

To use `http://gattini-watch.localhost` with no port, let a local reverse proxy that
already owns port 80 route the name. Gattini Watch itself never binds port 80. These
recipes are starting points and have not been tested against every setup.

Caddy, installed directly (`Caddyfile`):

```
http://gattini-watch.localhost {
	reverse_proxy 127.0.0.1:4777
}
```

Caddy or Traefik in Docker: Gattini Watch listens on loopback only, so a container reaches
it through `host.docker.internal:4777`. That works with Docker Desktop on macOS and
Windows. On Linux, run the proxy with `network_mode: host` and use `127.0.0.1:4777`.

Traefik (file provider):

```yaml
http:
  routers:
    gattini-watch:
      rule: Host(`gattini-watch.localhost`)
      service: gattini-watch
  services:
    gattini-watch:
      loadBalancer:
        servers:
          - url: http://host.docker.internal:4777
```

Keep a name ending in `.localhost`. The server answers only `localhost`-style names and
loopback addresses, and refuses everything else.

## Views

- **Tree**: one row for each agent, showing model, effort, sandbox, status, duration and tokens. Workers and subagents sit under whatever launched them.
- **Blocks**: one card for each top-level session, with a tile for each agent under it.

Every status has a colour, a symbol and a word: ▶ Working, ✕ Failed, ◌ Went quiet,
? No record, ⏸ Waiting for you, ✓ Finished. Claude is marked ✻ and Codex `>_`. Nothing
animates. The order holds still unless you pick a moving sort. **Pause** freezes the page
and queues updates.

You can pin projects to the top, filter by project, and choose how much detail each row
shows. You can also hide finished agents or Codex's guardian reviews.

The footer counts the logs read and the logs shown for each tool, for example
"Codex: 35 logs read · 35 shown". If the two numbers differ, it lists what was left out,
so a gap in the view cannot pass unnoticed.

## Where the data comes from

Gattini Watch only reads logs the tools already write. It changes nothing, and nothing
leaves the machine.

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl`, plus `<session>/subagents/`. Set `CLAUDE_CONFIG_DIR` if your logs are somewhere else.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Set `CODEX_HOME` if your logs are somewhere else. Subagents that Codex spawns are nested under their parent thread.

Neither tool records the other's session id. A worker is therefore linked to whoever
launched it when the launch command and the new session match on time (the session
starts within 3 minutes of the command) and on working folder.

Limitations:

- A Codex worker run with `--ephemeral` writes no log. It appears as **No record**, with only the details its launch command gives.
- Statuses are inferred from the logs. **Working** means a turn is open and the log changed in the last 10 minutes. **Went quiet** means a turn is open but nothing has been written for longer than that.
- Codex encrypts the task a parent hands to a spawned subagent, so those subagents are named by nickname and role, for example "Volta · scanner".
- The page shows prompts. That is why the server listens on loopback only and refuses requests addressed to other host names.

## Run from source

Requires Node 22 or later. There are no dependencies.

```sh
node bin/gattini-watch.mjs --open     # or: npm start
npm test                              # node --test, using fixture logs
```

The code is in `src/`:

- `jsonl.mjs` reads logs incrementally.
- `claude.mjs` and `codex.mjs` are the readers for each tool.
- `commands.mjs` detects launch commands.
- `fleet.mjs` builds the tree and the audit.
- `server.mjs` handles HTTP and server-sent events.

The page is in `public/`.

## License

MIT
