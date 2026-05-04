# CLAUDE.md — agent onboarding

This file is for AI coding assistants (Claude Code, Cursor, etc.) working on
this repo. End-user docs live in [README.md](README.md).

## What this repo is

A Bitburner orchestrator (`scb.js`) plus an autonomous AI player
(`ollama-player.js` + `ollama-actions.js`) backed by a local or LAN Ollama,
hot-reloaded from disk via a small Node watcher (`watch/scb-watch.js`) and a
filesync server. Everything outside that loop has been moved to `_archive/`.

## Architecture in one paragraph

The Mac runs three local services: `bitburner-filesync` (pushes saved files
into the game over WebSocket), `scb-watch.js` (watches a small allowlist for
edits, writes a restart marker, probes Ollama endpoints, writes a heartbeat),
and an opt-in `claude-bridge.js`. The game runs `scb.js` (orchestrator),
`scb-watchdog.js` (polls the markers — kills+restarts `scb.js` on edits, toasts
on Remote-API loss), and `ollama-player.js` (asks Ollama for actions every
60 s, executes through `ollama-actions.js`).

## Files you'll touch most

| File                             | Why                                            |
|----------------------------------|------------------------------------------------|
| `scb.js`                         | orchestrator — FLAGS, AI_CONFIG, SAFETY        |
| `ollama-actions.js`              | add new actions to ACTION_SCHEMA + dispatcher  |
| `ollama-player.js`               | OBSERVE / DECIDE / EXECUTE loop, prompt        |
| `watch/scb-watch.js`             | local Node daemon (file watch + Ollama probe)  |
| `scb-watchdog.js`                | in-game hot-reload daemon                      |
| `approve-patch.js`               | human-in-loop reviewer for AI patch proposals  |

## Conventions

* **Don't add new top-level scripts** when extending `scb.js` — add a flag
  to `FLAGS` and inline or auto-generate via an embedded template (see how
  `UPGRADER_CODE` and `CONTRACTOR_CODE` are done at the bottom of `scb.js`).
* **Bump the version marker** in any auto-gen template you change so the
  in-game `ensure*Exists` regenerates the file.
* **Don't introduce npm deps.** The bridge and watcher are pure Node stdlib
  on purpose; that's the contract.
* **Don't introduce new `.md` files** unless asked — this repo intentionally
  ships only `README.md` and `CLAUDE.md`.
* **Keep helpers in dedicated dirs** (`bridge/`, `watch/`) — only orchestrators
  and in-game scripts at the root.
* **AI safety surface** lives in `ollama-actions.js`: `PROTECTED`,
  `WRITE_ALLOWED_PREFIXES`, `normPath`, `isProtected`, `isWriteAllowed`. Any
  new action that writes / deletes / exec'd a file MUST go through them.
  Patch traversal is collapsed before the allowlist check — keep it that way.

## Game version

Bitburner 3.0.0+. `ns.tail` is removed (use `ns.ui.openTail`); the `ps` and
`cloud` namespaces are preferred over the legacy purchased-server APIs.
There are compat shims in `scb.js` (`ps.list`, `ps.buy`, etc.) for older
saves — don't strip them; flip via `?:`.

## Testing changes

There's no unit test harness — testing means actually running the loop.
Local syntax check before a commit:

```sh
for f in watch/scb-watch.js bridge/claude-bridge.js \
         ollama-actions.js ollama-player.js scb.js \
         scb-watchdog.js approve-patch.js; do
  node --check "$f" && echo "ok $f"
done
bash -n scb.sh && echo "ok scb.sh"
```

End-to-end: `./scb.sh restart && ./scb.sh sync-all`, then `kill scb.js && run scb.js`
in-game; tail `/scb-watchdog.js` and `/ollama-player.js` for live behaviour.

## What's in `_archive/`

The pre-trim workspace. Hundreds of game scripts (Bryden framework, casino
solver, etc.) that were here before the GitHub-prep cleanup. Don't import
from there — it's not part of the public surface. If something turns out to
be needed, copy it to root or to `bridge/`/`watch/` as appropriate.
