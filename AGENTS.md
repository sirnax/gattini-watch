# Agent working agreement

Gattini Watch is a zero-dependency Node (22+) dashboard of local Claude Code and Codex
agents. It is a sibling of [Gattini](https://github.com/sirnax/gattini) and is
shipped as a formula in the public tap `sirnax/homebrew-gattini`. Read
[README.md](README.md) first.

## Rules

- **Read only, loopback only.** Never write to the tools' logs. The server binds
  127.0.0.1 and ::1 only and refuses non-loopback `Host` headers. The logs contain prompts,
  so never weaken either rule.
- **No dependencies.** Use Node built-ins only, on both the server and the page.
- **Calm UI.** Nothing animates. Every status has a colour, a symbol and a word. Status
  colours must stay at 4.5:1 or better against both the panel and the page background, in
  light and dark.
- **Nothing starts on its own.** The documented default is `brew services run`. Starting
  at login is an opt-in. The service restarts only after a crash, so any stop holds.
- **Owner approval** is needed before pushing, tagging, publishing a release, changing
  the tap, or registering a login service on the owner's machine.
- Write no time estimates in docs.

## How the logs are read

Formats are inferred from real logs, not from documentation, so check against a real
file before changing a reader.

**Claude Code** (`src/claude.mjs`)
- Logs: `~/.claude/projects/<project>/<session>.jsonl`, plus
  `<session>/subagents/agent-<id>.jsonl` and `.meta.json`.
- `entrypoint` `sdk-cli` means a headless `claude -p` worker.

**Codex** (`src/codex.mjs`)
- Logs: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`.
- **A log's identity is its first `session_meta`.** Later headers are copies, from
  parents or other threads.
- Spawned subagents (`source.subagent.thread_spawn`) start with a copy of the parent's
  conversation. Ignore everything before their first `thread_settings_applied` event.
- The task a parent hands to a subagent is encrypted, so subagents are named
  "nickname · role path".
- Guardian reviews have `thread_source: guardian_review`.
- `--ephemeral` runs write no log.

**Cross-tool links** (`src/fleet.mjs`)
- Neither tool records the other's id, so a launch command is matched to a new session by
  time (from 15 s before to 3 min after) and working folder.

**Audit**
- Every snapshot reports logs read against logs shown, for each tool. A gap there is a bug.

## Checks

```sh
npm test                                   # fixture logs; covers the cases above
node bin/gattini-watch.mjs --json | head   # real logs; check the audit numbers match
```

For UI changes, check the page at desktop width and at 390 px, in light and dark.

## Releasing

1. Bump `version` in `package.json` and commit. Run `npm test`.
2. Build the archive and its checksum:
   ```sh
   npm pack --pack-destination dist
   (cd dist && shasum -a 256 gattini-watch-X.Y.Z.tgz > gattini-watch-X.Y.Z.tgz.sha256)
   ```
   `npm pack` is reproducible: two builds must be byte-identical.
3. Tag `vX.Y.Z`, push, and run
   `gh release create vX.Y.Z dist/gattini-watch-X.Y.Z.tgz dist/gattini-watch-X.Y.Z.tgz.sha256`.
4. Download the archive back without authentication and check its checksum.
5. Render the formula from the verified archive:
   ```sh
   node scripts/render-formula.mjs --archive "$PWD/dist/gattini-watch-X.Y.Z.tgz" \
     --url https://github.com/sirnax/gattini-watch/releases/download/vX.Y.Z/gattini-watch-X.Y.Z.tgz \
     --out <tap>/Formula/gattini-watch.rb
   ```
6. In the tap, run `brew audit --strict --formula sirnax/gattini/gattini-watch`, then
   commit and push.
7. Check with `brew upgrade gattini-watch` (or install), then `brew test gattini-watch`.

Never set `HOMEBREW_NO_INSTALL_FROM_API` for an audit: it starts a full homebrew-core
clone.
