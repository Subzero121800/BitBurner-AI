# scb / claude-bridge

Tiny HTTP shim so the in-game `/ollama-player.js` can use Claude as
its AI backend. Speaks an Ollama-compatible `/generate` endpoint and
**shells out to the local Claude Code CLI** (`claude -p`) for each
request — so it inherits whatever auth you've already got logged in
(Pro/Max plan, or `ANTHROPIC_API_KEY` if you've set one).

**Zero npm dependencies.** Pure Node stdlib + `spawn("claude")`.

## Run

Make sure `claude` is on your PATH:

```sh
which claude   # /usr/local/bin/claude or similar
claude --version
```

Then start the bridge:

```sh
./scb.sh bridge          # via the project launcher
# or:
node bridge/claude-bridge.js
```

No API key needed. The bridge inherits the CLI's auth.

## Wire up

In `scb.js`:

```js
const AI_CONFIG = {
  backend:     "claude",
  claudeHost:  "http://localhost:3000",   // or Mac/Jetson IP
  claudeModel: "sonnet",                  // optional — empty uses CLI default
  ...
};
```

Set `FLAGS.ollamaPlayer = true`, then `run scb.js`.

## Endpoints

| Method | Path        | Purpose                                                |
|--------|-------------|--------------------------------------------------------|
| POST   | `/generate` | Ollama-compatible JSON body `{ system, prompt, model }`|
| GET    | `/generate` | Same, query-encoded — used by `ns.wget` fallback       |
| GET    | `/healthz`  | Reports `claude --version` and configured model        |

Response shape:

```json
{
  "response": "...assistant text...",
  "model": "claude-sonnet-4-6",
  "usage": { ... },
  "cost_usd": 0.0123,
  "duration_ms": 2100
}
```

## Optional env (in `bridge/.env`)

| Var                 | Default | Notes                                       |
|---------------------|---------|---------------------------------------------|
| `PORT`              | `3000`  | HTTP listen port                            |
| `CLAUDE_BIN`        | `claude`| Override path to Claude Code binary         |
| `CLAUDE_MODEL`      | (empty) | Passed to `claude --model`. Empty = default |
| `CLAUDE_TIMEOUT_MS` | `90000` | Per-request timeout                         |

## Want Ollama instead?

If you'd rather run Llama on a Jetson, you don't need this bridge —
point `AI_CONFIG.ollamaHost` directly at `http://<ip>:11434` and set
`backend: "ollama"`. The bridge is only for the Claude path.
