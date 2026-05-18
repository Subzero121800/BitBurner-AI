# scb — Bitburner SCB Orchestrator + Ollama AI Player

A modular automation stack for [Bitburner](https://bitburner-official.github.io/), with an autonomous AI player that uses **Ollama** (local or self-hosted LAN) — or optionally Claude — to make decisions, and a guard‑railed file‑system surface so the model can extend itself without bricking your save.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-jcinc-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jcinc)
![License](https://img.shields.io/badge/License-MIT-blue)
![Bitburner](https://img.shields.io/badge/Bitburner-3.0%2B-green)

> 👋 Built by a disabled veteran in the gaps between appointments. If `scb` saves you time, a ⭐ on the repo is free and is the single most useful thing you can do. A [coffee or pizza](https://buymeacoffee.com/jcinc) keeps the commits coming. The AI player remains unimpressed by your generosity — I am not.

![SCB Bitburner architecture: editor → filesync → game, with scb-watch on the host writing /Temp markers, and the in-game scb / watchdog / ollama-player / approve-patch layer talking to Ollama](docs/architecture.png)

---

## Quick start

```sh
git clone https://github.com/Subzero121800/BitBurner-AI.git
cd BitBurner-AI
chmod +x scb.sh

# Install Ollama somewhere reachable, then pull a model
ollama serve &                       # local default — see Config section for LAN
ollama pull deepseek-coder-v2:16b    # or llama3.1:8b for low-RAM hosts

./scb.sh start                       # filesync :12525 + scb-watch (Ollama probe)
```

Then in **Bitburner**:

1. *Options → Remote API → Connect* (and tick *Auto‑connect on Start*)
2. In the in-game terminal: `run scb.js`

You should see `INFO  ollamaHost: http://...` print in the player's tail. From here, every save to `scb.js` / `ollama-player.js` / `ollama-actions.js` hot‑reloads the orchestrator within ~3 seconds.

---

<details>
<summary><strong>📺 Screenshots</strong> — what it looks like running</summary>
<br>

Orchestrator + AI player picking real actions in real time:

![scb.js orchestrating + Ollama Player executing actions](docs/screenshots/scb-orchestrator.png)

`/scb-watchdog.js` riding through Remote API connect/disconnect cycles while the orchestrator keeps backdooring servers in parallel:

![Backdoor sweep + watchdog detecting Remote API drops](docs/screenshots/watchdog-reconnect.png)

The safety policy doing its job — model wanted to upgrade a server, cash-reserve check rejected it cleanly without crashing the loop:

![AI safety rails rejecting an upgrade_server action that would violate cash reserve](docs/screenshots/ai-safety-rails.png)

</details>

---

## ⚙️ Configuring the AI backend

The system supports two backends. **Ollama is the default** — fully local or LAN-hosted, no API key. **Claude** is opt-in via the local CLI.

<details>
<summary><strong>Ollama — local install (simplest)</strong></summary>
<br>

If Ollama is running on the same Mac that runs `scb.sh`, **no configuration is needed**. `scb-watch` probes `http://127.0.0.1:11434` on startup and every 5 minutes, and writes the discovered host to `/Temp/ollama-host.txt`. The in-game player reads that file every cycle.

```sh
brew install ollama        # or your platform's installer
ollama serve &
ollama pull deepseek-coder-v2:16b
```

To change which model the player uses, edit [`scb.js`](scb.js):

```js
const AI_CONFIG = {
  backend:      "ollama",
  ollamaModel:  "deepseek-coder-v2:16b",   // ← change me
  // ...
};
```

Save → the watchdog hot-reloads scb.js → player respawns with the new model.

</details>

<details>
<summary><strong>Ollama — self-hosted on LAN (Jetson, GPU box, server)</strong></summary>
<br>

If your Ollama lives on a different machine (e.g. a Jetson, a dedicated GPU server, or another Mac on your LAN), drop a JSON array into `watch/ollama-candidates.json`:

```json
[
  "http://127.0.0.1:11434",
  "http://10.0.0.42:11434",
  "http://192.168.1.50:11434"
]
```

That file is **gitignored** — your network topology stays out of source control. A starter template lives at [`watch/ollama-candidates.example.json`](watch/ollama-candidates.example.json).

`scb-watch` probes them in order. The **first one to respond** to `GET /api/tags` wins and gets written to `/Temp/ollama-host.txt`. The in-game player picks it up automatically — no in-game config needed.

If the chosen host goes offline mid-session, scb-watch re-probes every 5 minutes and falls through to the next candidate. So you can run "primary GPU box + fallback CPU box" for resilience.

**Make sure Ollama is reachable from your Mac:**

```sh
# On the Ollama host:
OLLAMA_HOST=0.0.0.0:11434 ollama serve   # bind to LAN, not localhost-only

# From your Mac:
curl http://<ollama-host>:11434/api/tags  # should return JSON listing pulled models
```

If `curl` works but `scb-watch` doesn't pick it up, check `tail -f .run/watch.log` — it logs `ollama detected: ...` on success and `no candidate reachable` on failure.

**Choosing a model size:**

| Model                    | Roughly       | Good for                                           |
|--------------------------|---------------|----------------------------------------------------|
| `llama3.1:8b`            | 5 GB VRAM     | Low-RAM Macs / older GPUs. Won't propose patches reliably. |
| `deepseek-coder-v2:16b`  | 9 GB VRAM     | **Recommended default.** Reads source, emits propose_patch coherently. |
| `qwen2.5-coder:32b`      | 19 GB VRAM    | Better code reasoning. Needs a serious GPU.        |
| `llama3.1:70b`           | 40 GB VRAM    | Best quality on consumer hardware. Multi-GPU helpful. |

Set the chosen model in `AI_CONFIG.ollamaModel` in `scb.js`.

</details>

<details>
<summary><strong>Claude (opt-in) — via local Claude Code CLI</strong></summary>
<br>

If you'd rather use Claude as the backend, the project ships a tiny opt-in HTTP shim ([`bridge/claude-bridge.js`](bridge/claude-bridge.js)) that shells out to your local `claude` CLI. **It inherits whatever auth Claude Code is using** — Pro/Max plan or `ANTHROPIC_API_KEY` — so no key needs to live in this repo.

```sh
# 1. Make sure the CLI works
claude --version

# 2. Start the bridge (NOT auto-started by scb.sh start)
./scb.sh bridge
```

Then flip the backend in [`scb.js`](scb.js):

```js
const AI_CONFIG = {
  backend:      "claude",
  claudeHost:   "http://localhost:3000",
  claudeModel:  "sonnet",                  // "sonnet" | "opus" | "haiku" | full id
  // ...
};
```

Optional: customize via [`bridge/.env`](bridge/.env.example):

| Var                 | Default | Effect                                       |
|---------------------|---------|----------------------------------------------|
| `PORT`              | `3000`  | Bridge HTTP port                             |
| `CLAUDE_BIN`        | `claude`| Path override (for nvm/asdf/non-default installs) |
| `CLAUDE_MODEL`      | (CLI default) | Passed via `claude --model`           |
| `CLAUDE_TIMEOUT_MS` | `90000` | Per-request timeout                          |

The bridge is **localhost-only** and **opt-in** — `./scb.sh start` doesn't launch it. Stop with `./scb.sh stop` (kills all services) or kill the pid in `.run/bridge.pid`.

</details>

<details>
<summary><strong>All <code>AI_CONFIG</code> fields explained</strong></summary>
<br>

Defined in [`scb.js`](scb.js); passed to `/ollama-player.js` as a JSON arg every spawn.

| Field            | Default                            | What it does                                                        |
|------------------|------------------------------------|---------------------------------------------------------------------|
| `backend`        | `"ollama"`                         | `"ollama"` or `"claude"`                                            |
| `ollamaHost`     | `"http://127.0.0.1:11434"`         | Fallback if `/Temp/ollama-host.txt` is empty/missing                |
| `ollamaModel`    | `"deepseek-coder-v2:16b"`          | Model passed to `/api/generate`                                     |
| `claudeHost`     | `"http://localhost:3000"`          | Bridge endpoint when `backend === "claude"`                         |
| `claudeModel`    | `"sonnet"`                         | Sonnet / opus / haiku / full model id                               |
| `pollInterval`   | `300_000` (5 min)                  | How often the AI cycle fires. Lower = more reactive + more inference cost |
| `timeoutMs`      | `90_000`                           | Per-call timeout. 16B models can run 30–60 s on consumer hardware.  |
| `temperature`    | `0.2`                              | Ollama sampling temperature. Low = deterministic.                   |
| `numCtx`         | `8192`                             | Ollama context window. Increase if recentActions gets truncated.    |
| `recentLogLines` | `30`                               | How many log lines feed back as `state.recentActions`               |
| `jamThreshold`   | `3`                                | Identical-failure count before `REPEAT-SUPPRESSED` server-side       |

</details>

---

## 💾 RAM cost & limiting in-game memory

> Real talk on the in-game RAM footprint, since this got asked on r/Bitburner.

<details>
<summary><strong>🆕 v9 dispatch split — player dropped ~131 GB → ~8 GB</strong></summary>
<br>

Bitburner charges static RAM by walking every `ns.*` reference reachable through your imports. Up through v8, `ollama-player.js` did `import { executeAction } from "/ollama-actions.js"`, which pulled the full singularity / sleeve / gang / hacknet / bladeburner / cloud namespaces into the player's RAM ledger — about **131 GB** resident, even on cycles that just emitted `noop`. (The previous README claim of "~8 GB" for the player was wrong; sorry.)

**v9 splits the dispatcher into purpose-specific helpers** under `/ai/dispatch/` and reads game state from snapshot files written by helpers under `/ai/snap/`. The player itself only knows how to:

- read JSON state from `/Temp/*.json`
- write a pending-action JSON
- `ns.exec` the right helper for the chosen action category
- poll for the result file and return it

```
ollama-player.js   ──reads──>   /Temp/network-state.json     ←─── /ai/snap/network.js     (~5 GB, runs <1s)
                   ──reads──>   /Temp/cloud-state.json       ←─── /ai/snap/cloud.js       (~13 GB, runs <1s)
                   ──reads──>   /Temp/progression-state.json ←─── /ai/snap/progression.js (~12-30 GB, runs <1s)

                   ──writes──>  /Temp/ai-action-req.json
                   ──exec───>   /ai/dispatch/<category>.js  ──writes──>  /Temp/ai-action-res.json
                   ──polls──>   /Temp/ai-action-res.json
```

Each helper pays its own NS-namespace RAM cost **only while running** (a few hundred ms) and frees it on exit. The player's resident footprint drops from 131 GB to ~6–8 GB.

**Helper map:**

| Helper | Category | Static RAM (peak, transient) | When it runs |
|---|---|---|---|
| `/ai/snap/network.js`     | snapshot — topology + targets    | ~5 GB             | every scb cycle (~30s) |
| `/ai/snap/cloud.js`       | snapshot — purchased server fleet | ~13 GB           | every scb cycle |
| `/ai/snap/progression.js` | snapshot — augs + factions       | ~12 GB at SF4-3, up to ~120 GB at SF4-1 | every scb cycle |
| `/ai/dispatch/deploy.js`      | hack/grow/weaken/deploy_hack | ~8 GB  | when AI deploys workers |
| `/ai/dispatch/singularity.js` | travel/work/study/buy_program/install_augs/etc. | ~12 GB at SF4-3, ~120 GB at SF4-1 | when AI calls a singularity action |
| `/ai/dispatch/cloud.js`       | buy_server / upgrade_server | ~13 GB | when AI mutates the fleet |
| `/ai/dispatch/sleeve.js`      | sleeve_task                 | ~32 GB (no SF10-3) / ~4 GB (SF10-3) | rare — most sleeve work goes via `set_sleeve_plan` |
| `/ai/dispatch/gang.js`        | gang_recruit/assign/ascend  | ~16 GB | rare — most gang work goes via `set_gang_plan` |
| `/ai/dispatch/hacknet.js`     | buy/upgrade hacknet         | ~20 GB | when AI buys/upgrades hacknet |
| `/ai/dispatch/blade.js`       | bb_action / bb_skill        | ~8 GB  | rare — most BB work goes via `set_bladeburner_plan` |
| `/ai/dispatch/fs.js`          | read/write/run/kill/copy/patch | ~6 GB | when AI touches files |
| `helpers/darknet-snapshot.js` | darknet state probe         | ~4 GB  | every darknet-manager cycle |
| `helpers/darknet-execute.js`  | heartbleed / phishing / migrate / pump-dump | ~6 GB | when manager queues heavy ops |
| `helpers/darknet-crawler.js`  | per-node probe + auth + spread | ~2 GB | persistent on each authed darknet server |

Inline (no exec round-trip, no extra RAM): `noop`, `wait`, `set_sleeve_plan`, `set_gang_plan`, `set_bladeburner_plan` (pure JSON writes the player handles itself).

The user's home cap (`FLAGS.maxInGameRamGB`) still applies to every spawned helper — `scb.js`'s `withinRamBudget` check is honored before each `ns.exec`, so the cap can't be blown by a snap script firing.

**Why the singularity numbers are a wide range:** `ns.singularity.*` functions cost 0.5 GB at the base rate but the SF4 multiplier is ×16 / ×4 / ×1 at SF4-1 / SF4-2 / SF4-3. Buying SF4-3 (and SF7-3 for bladeburner, SF10-3 for sleeve) collapses these costs ~8× across the board.

</details>

<details>
<summary><strong><code>FLAGS.maxInGameRamGB</code> — the soft cap (recommended)</strong></summary>
<br>

There's a single configurable knob that caps how much **home** RAM the system is allowed to consume across everything it spawns (companions, AI player, auto-generated workers). `scb.js` itself is exempt — without it, nothing else can launch.

Edit [`scb.js`](scb.js):

```js
const FLAGS = {
  // ...
  // 0 = unlimited; otherwise budget cap in GB.
  maxInGameRamGB: 32,   // ← e.g. cap at 32 GB
  // ...
};
```

When the cap is set, `ensureRunning` checks each launch against the running total. Anything that would push past the cap is **skipped with a clear log line**:

```
WARN  skipping /bladeburner-manager.js — would exceed maxInGameRamGB=32 (cost 16.0 GB, used 26.4 GB)
```

The budget is also published to `/Temp/economy.json` and surfaced in the AI player's prompt as `state.budget`. When `state.budget.tight` is true, the model is told to stop proposing actions that spawn new home-side scripts and pick income actions that use existing capacity instead.

**Suggested values** — caps are sized against the *measured* static RAM costs in the next table, with a small headroom margin for transient `/ai/snap/` + `/ai/dispatch/` helpers (which can briefly materialize 13–32 GB during execution).

| `maxInGameRamGB` | What fits at this cap                                                                  |
|------------------|----------------------------------------------------------------------------------------|
| `0` (unlimited)  | Full stack — default. Cap is off.                                                      |
| `24`             | Orchestrator + watchdog only (~20.65 GB measured). Pure automation, no AI.            |
| `48`             | Adds the v9 AI player (~27 GB total). Snapshot helpers fit transiently in headroom.   |
| `96`             | Adds one heavy companion — gang-manager OR bladeburner-manager (~59 GB total).         |
| `128`            | Adds gang + bladeburner + sleeve managers (~115 GB total). Full stack with margin.    |

Default is `0` (unlimited) — no behavior change unless you opt in. Pick the lowest cap that comfortably fits the components you actually want to run **plus the largest transient helper they'll trigger** (worst case: `/ai/snap/progression.js` at ~30 GB without SF4-3, or `/ai/dispatch/sleeve.js` at ~32 GB without SF10-3). Anything that would push past the cap is skipped with a `WARN` line and the AI is told via `state.budget.tight`.

</details>

<details>
<summary><strong>Approximate RAM cost on <code>home</code></strong></summary>
<br>

Bitburner charges static RAM per-script based on which `ns.*` API surfaces a script imports. Approximate costs **(v9 dispatch-split — see callout above)**:

**Resident (always running while features are enabled).** Numbers below are *measured in-game* via `getScriptRam` on a real save (not estimates):

| Script                       | Measured RAM | What drives the cost                                |
|------------------------------|--------------|-----------------------------------------------------|
| `scb.js` (orchestrator)      | **19.05 GB** | Singularity (purchase, backdoor), `ns.cloud.*`, scan |
| `ollama-player.js` (v9)      | **~6–8 GB**  | `ns.exec` to dispatchers, `getPlayer`, `format`, JSON snapshot reads (was ~131 GB pre-v9) |
| `ollama-actions.js` (lib)    | **~0 GB**    | Pure schema/validate; no NS calls (was implicitly ~131 GB via re-export)  |
| `scb-watchdog.js`            | **1.60 GB**  | `ns.exec`, `ns.kill`, `ns.write`                    |
| `gang-manager.js`            | **31.90 GB** | `ns.gang.*` namespace is heavier than expected — ~21 unique calls    |
| `bladeburner-manager.js`     | ~28–32 GB    | `ns.bladeburner.*` ×17 unique calls. Same shape as gang.            |
| `sleeve-manager.js`          | ~8–32 GB     | `ns.sleeve.*` cost collapses with SF10-3                            |
| `darknet-manager.js`         | ~4–8 GB      | Darknet autopilot — session owner, auth pass, crawler deploy         |
| `stats.js`                   | **2.60 GB**  | Companion — small reader/UI                                          |
| `spend-hacknet-hashes.js`    | **6.70 GB**  | Hacknet upgrade automation                                            |
| `hack/grow/weaken.js`        | ~1.7 GB ea   | Run on worker servers, not home                     |

**Transient (only resident while running — typically <1 second per invocation):**

| Helper                          | Peak RAM   | Trigger                                       |
|---------------------------------|------------|-----------------------------------------------|
| `/ai/snap/network.js`           | ~5 GB      | Every scb cycle (~30 s)                        |
| `/ai/snap/cloud.js`             | ~13 GB     | Every scb cycle                                |
| `/ai/snap/progression.js`       | ~12–120 GB | Every scb cycle (range = SF4 multiplier)        |
| `/ai/dispatch/deploy.js`        | ~8 GB      | AI emits hack/grow/weaken/deploy_hack          |
| `/ai/dispatch/singularity.js`   | ~12–120 GB | AI emits work/study/buy/install (SF4-dependent) |
| `/ai/dispatch/cloud.js`         | ~13 GB     | AI emits buy_server / upgrade_server           |
| `/ai/dispatch/sleeve.js`        | ~4–32 GB   | AI emits sleeve_task (rare; SF10-dependent)    |
| `/ai/dispatch/gang.js`          | ~16 GB     | AI emits gang_recruit/assign/ascend (rare)     |
| `/ai/dispatch/hacknet.js`       | ~20 GB     | AI emits hacknet upgrade                       |
| `/ai/dispatch/blade.js`         | ~8 GB      | AI emits bb_action / bb_skill (rare)            |
| `/ai/dispatch/fs.js`            | ~6 GB      | AI emits read/write/run/kill/copy/patch        |
| `/ai/dispatch/ui.js`            | ~1.6 GB    | AI emits reconnect_remote_api                  |

**Total resident core (orchestrator + watchdog): ~20.65 GB** (measured). Add the v9 AI player: **~27 GB.** Add gang-manager: **~59 GB.** Full stack with gang + bladeburner + sleeve: **~115–120 GB** (gang and bladeburner are the heavy hitters; sleeve collapses to ~8 GB at SF10-3). The transient `/ai/snap/` and `/ai/dispatch/` helpers materialize on demand and free their RAM on exit, so they don't add to the steady-state floor — they just need to *fit* against `FLAGS.maxInGameRamGB` for the few hundred ms they run.

Measure exact cost in-game: `getScriptRam("scb.js")` from another script, or check the RAM indicator in `nano`.

</details>

<details>
<summary><strong>Manual low-RAM setup (alternative to <code>maxInGameRamGB</code>)</strong></summary>
<br>

If you'd rather flip features individually instead of using the budget cap, [`scb.js`](scb.js)'s `FLAGS` lets you turn each one off:

```js
const FLAGS = {
  // Core (cheap, leave on)
  scanAndRoot:       true,
  backdoor:          true,
  buyTor:            true,
  buyPrograms:       true,
  serverUpgrader:    true,
  deployHackScripts: true,
  autoContracts:     true,
  watchdog:          true,

  // Disable until you have headroom
  ollamaPlayer:      false,            // ← ~8 GB saved
  launchCompanions:  false,            // ← ~32 GB saved if you ran both managers
  companions:        {}
};
```

Or keep companions on but enable them one at a time:

```js
launchCompanions: true,
companions: {
  "gang-manager.js":            true,    // 16 GB — only after you're in a gang
  "bladeburner-manager.js":     false,   // 16 GB — only after Bladeburner stats hit 100
  "sleeve-manager.js":          true,    //  8 GB — only after SF-10 grants sleeves
}
```

`maxInGameRamGB` and per-flag toggles compose: even with `launchCompanions: true`, anything that exceeds the budget is silently skipped with a `WARN` log.

</details>

---

<details>
<summary><strong>🛡️ Safety / economy policy</strong></summary>
<br>

Configured in `SAFETY` in [`scb.js`](scb.js). Every cycle, scb.js publishes the live policy to `/Temp/economy.json` so other in-game scripts (the upgrader, future helpers) honor the same numbers.

| Setting                  | Default     | Effect                                                                                                    |
|--------------------------|-------------|-----------------------------------------------------------------------------------------------------------|
| `maxActionsPerCycle`     | `5`         | Hard cap on actions per AI cycle.                                                                         |
| `minCashReserve`         | `$1M`       | **Hard floor.** Any action that would drop liquid home cash below this is rejected.                       |
| `savingsTarget`          | `$100M`     | **Soft target.** While cash &lt; (`minCashReserve` + `savingsTarget`), discretionary spending is paused.  |
| `cashSpendCapPct`        | `90`        | Once savings unlocked, per-cycle spend ceiling as a % of starting-cycle cash.                             |
| `minAugsToInstall`       | `5`         | `install_augmentations` rejected if fewer than this many are queued.                                      |
| `requireConfirmForReset` | `true`      | Blocks `install_augmentations` / `soft_reset` unless `/Temp/ai-confirm-reset.txt` exists.                 |
| `blockedActions`         | `["soft_reset"]` | Hard deny list.                                                                                      |
| `logAllActions`          | `true`      | Gates `/logs/ollama-player.txt` writes. Required for jam suppression to work.                             |

**How savings works:** discretionary actions (`buy_program`, `buy_server`, `upgrade_server`, `buy_augmentation`, `donate_faction`) get rejected with `SAVINGS-LOCKED: cash is $X short of savings target ($Y)` whenever the threshold isn't met. Income-generating actions still run. Once cash crosses the threshold the lock dissolves until a big spend drains it — then it re-locks.

**Repeat-suppression:** the `safetyCheck` validator computes `state.jammedActions` from the recent log. Any proposal whose JSON matches a jammed signature gets rejected with `REPEAT-SUPPRESSED (Nx): identical action just failed — try a different approach`. The rejection text goes back into the next cycle's `recentActions`, so even a stubborn model gets the message.

</details>

<details>
<summary><strong>📁 AI filesystem & process actions (guard-railed)</strong></summary>
<br>

The AI exposes a sandboxed surface via `/ollama-actions.js` so the model can write its own helper scripts and run them without touching the orchestrator core.

| Action                    | Effect                                                                              |
|---------------------------|-------------------------------------------------------------------------------------|
| `read_file`               | Read any file (no path restriction). Result truncated at 4 KB.                      |
| `list_files`              | List home-dir files, optionally prefix-filtered.                                    |
| `write_generated_script`  | Write content. Only to `/ai/generated/`, `/ai/scratch/`, `/Temp/`, `/logs/`.        |
| `delete_generated_script` | Delete a file in the same allowed dirs.                                             |
| `run_script`              | Exec a script that lives in an allowed dir on home or any rooted server.            |
| `kill_script`             | Kill all instances of a filename on a host (intentionally open — reversible).       |
| `copy_script`             | Copy from home (allowed dir) to a rooted server.                                    |
| `propose_patch`           | Write a patch proposal for a PROTECTED file → `/ai/patches/pending-patch.json`.     |

**Path traversal:** `..` collapsed before allowlist check. The AI cannot escape `/ai/generated/` via `/ai/generated/../scb.js`.

**Protected files** (cannot be written / deleted / exec'd by the AI directly):

```
scb.js                ollama-actions.js     scb-watchdog.js
ollama-player.js      contractor.js         server-upgrader.js
hack.js  grow.js  weaken.js  helpers.js  autopilot.js
```

To change one, the AI emits a `propose_patch` action. Proposal lands in `/ai/patches/pending-patch.json`, you get a toast, and review with:

```
home / $ run /approve-patch.js              # show pending proposal
home / $ run /approve-patch.js --approve    # apply (snapshot saved)
home / $ run /approve-patch.js --discard    # reject
home / $ run /approve-patch.js --list       # show history
```

Applied patches are archived to `/ai/patches/applied-<ts>.json` for manual rollback.

</details>

<details>
<summary><strong>🎛️ Manager directives (AI-steerable companions)</strong></summary>
<br>

The three autonomous companions (`gang-manager.js`, `bladeburner-manager.js`, `sleeve-manager.js`) ship with safe-default heuristics, but the AI player can override them per-cycle by emitting one of three actions:

| Action                  | Writes to                              | Plan shape (top-level keys)                                                                              |
|-------------------------|----------------------------------------|----------------------------------------------------------------------------------------------------------|
| `set_sleeve_plan`       | `/Temp/sleeve-directives.json`         | `default?:{task,...}`, `sleeves?:{ "0":{task,...} }`, `allowAugs?:bool`, `minCashForAugs?:number`        |
| `set_gang_plan`         | `/Temp/gang-directives.json`           | `createFaction?`, `memberOverrides?:{name:task}`, `allowEquipment?:bool`, `warfareOverride?:bool\|null`  |
| `set_bladeburner_plan`  | `/Temp/bladeburner-directives.json`    | `actionOverride?:{type,name}`, `antiChaosThreshold?:number`, `skillPriorities?:[name,...]`               |

Sleeve task names: `shock_recovery` · `synchronize` · `idle` · `commit_crime` · `gym` · `study` · `company_work` · `faction_work`.

**Each directive expires 10 minutes after `ts`.** If the AI goes silent or crashes, the companion falls back to its safe defaults — there's no way for a stale plan to steer indefinitely.

**Each companion publishes its own state.** Every cycle each manager writes a snapshot to `/Temp/<manager>-state.json` (count, per-member tasks, shock/sync, chaos by city, etc.). The AI sees these as `state.managers.{sleeve,gang,bladeburner}` and uses them to decide whether overriding the default is even worth doing.

Example `set_sleeve_plan` payload the AI might emit:

```json
{
  "action": "set_sleeve_plan",
  "plan": {
    "default": { "task": "commit_crime", "crime": "Homicide" },
    "sleeves": { "0": { "task": "synchronize" } }
  }
}
```

</details>

<details>
<summary><strong>🕸️ Darknet autopilot (<code>darknet-manager.js</code>)</strong></summary>
<br>

Bitburner 3.0+ ships an `ns.dnet` namespace for the **Darknet** — a hidden network of servers behind password-gated authenticated sessions. The darknet stack runs as a standalone companion alongside the main orchestrator.

**Files:**

| File | Role |
|---|---|
| `darknet-manager.js` | Resident orchestrator — PID-owns sessions, runs the auth pass, deploys crawlers, queues heavy ops |
| `helpers/darknet-snapshot.js` | Transient — reads `ns.dnet` state → `/Temp/darknet-snap.json` each cycle |
| `helpers/darknet-execute.js` | Transient — applies a batch of heavy ops (heartbleed, phishing, memreal, migrate, pump-dump) |
| `helpers/darknet-crawler.js` | Persistent per-node — self-replicating; probes + authenticates neighbours + spreads itself |

**How it authenticates servers:**

Darknet sessions in Bitburner are PID-bound — only the script that called `authenticate()` can reuse the session via `connectToSession()`. The manager and crawlers cooperate:

1. Manager authenticates `darkweb` → owns that session → deploys a crawler onto it
2. Crawler calls `probe()` natively from darkweb's position, authenticates neighbours, spreads to each, writes `/Temp/darknet-disc-darkweb.json` and SCPs it home
3. `darknet-snapshot.js` merges crawler disc files + `ns.dnet.labradar()` (up to ~391 visible nodes) → marks all confirmed hosts `isDarknet: true`
4. Manager reads the snapshot each cycle, union-merges live session probes with disc data, attempts `authenticate()` for each unclaimed neighbour while pre-connected to its parent session

**Password solver** — both the manager and the crawler carry an identical hint-based solver:

| Trigger | Approach |
|---|---|
| Model `ZeroLogon` | Fixed password `"0"` |
| Model `Factori-Os` | All prime numbers of the required digit length (sieve) |
| Model `Pr0verFl0` | Buffer-overflow fillers: repeated `a`/`A`/`x` + common words at exact length |
| `passwordLength == 0` | Empty string `""` |
| Hint contains `"divisible"` + wink `;)` or `:)` | Primes of hint length |
| Hint contains `"divisible by N"` | Multiples of N within the correct digit range |
| Hint contains `"value"` | Parses Roman numerals from the data field |
| Hint contains `"base"` | Parses `"base,value"` from data field (base conversion) |
| Hint contains `"between N and M"` | Enumerates integers strictly between N and M |
| Hint contains `"human"` | Extracts only the digit characters from the data field |
| Hint contains `"buffer"` | Filler strings padded to exact required length |
| Hint contains `"dog"` | Tries `["fido", "spot", "rover", "max"]` |
| Hint ends in a bare number, no data | Tries that number directly |
| Unknown hint | Ollama fallback — queries the configured LAN model with hint + format + length + data; cached per host |

**Directives** — write `/Temp/darknet-directives.json` to steer the manager (expires after 10 min):

```json
{
  "ts": 1234567890000,
  "mode": "auto",
  "minDepth": -1,
  "maxDepth": 999,
  "ignoreCharisma": false,
  "stasisPolicy": "deepest"
}
```

`mode` values: `"auto"` (default — auth + ops), `"manual"` (no auto auth/ops), `"off"` (fully paused), `"cha_grind"` (runs phishing for charisma XP), `"explore"` (heartbleed + auth expansion priority).

**Logs:** `/logs/darknet.txt` (rotates at 256 KB → `/logs/darknet.1.txt`). Auth successes and failures, crawler deploys, and cache hits all land here.

**Note:** `darknet-manager.js` checks `if (!ns.dnet)` at startup and idles gracefully if the namespace isn't available — safe to leave enabled on saves that haven't reached the darknet yet.

</details>

<details>
<summary><strong>🔁 Hot-reload + observability</strong></summary>
<br>

```
edit + save  →  scb-watch (host)  →  /Temp/scb-restart.txt  →  filesync  →  game
                                                                              │
                                                            /scb-watchdog.js ←┘
                                                            kills + re-execs scb.js
```

Watched files: `scb.js`, `ollama-player.js`, `ollama-actions.js`. Editing `bridge/claude-bridge.js` or `bridge/.env` instead bounces the local bridge process directly (no in-game restart).

The watcher also writes `/Temp/scb-heartbeat.txt` every 2 s. The in-game watchdog flags Remote API as offline if the heartbeat goes older than 15 s.

**Companion auto-bounce.** Each in-repo companion (`gang-manager.js`, `bladeburner-manager.js`, `sleeve-manager.js`) carries a `*_VERSION_<n>` marker in its source and publishes the same marker into `/Temp/<name>-state.json` every cycle. When you edit a companion + bump its marker, scb.js's `ensureCompanionFresh` notices the disk version no longer matches the running snapshot's `version` field, kills the running instance, and lets the next cycle re-spawn the new code. So companion edits hot-reload too — no in-game restart needed beyond the version bump.

**Per-companion state snapshots.** Each manager writes its full per-cycle state to `/Temp/<name>-state.json` (count, per-member tasks, shock/sync, chaos by city, etc.). The AI player picks these up as `state.managers.{sleeve, gang, bladeburner}` so it can decide whether to override the manager's defaults via the directive actions described above.

**Persistent logs** — disk-backed history of what the orchestrator and AI did:

| In-game file              | Source              | Contents                                                          |
|---------------------------|---------------------|-------------------------------------------------------------------|
| `/logs/scb.txt`           | `scb.js`            | One CYCLE line per orchestrator pass                              |
| `/logs/ollama-player.txt` | `ollama-player.js`  | `OK`/`SKIP`/`FAIL` per action with full context                   |
| `/logs/gang.txt`          | `gang-manager.js`   | Recruit / task / ascend / equip events                            |
| `/logs/bladeburner.txt`   | `bladeburner-manager.js` | Action selection, skill purchases                            |
| `/logs/sleeve.txt`        | `sleeve-manager.js` | SET / STATUS / WARN / AUG events (per-sleeve)                     |

(`.txt` rather than `.log` so the in-game `download <file>` command accepts them.)

Both rotate at ~256 KB. Every 30 s the in-game watchdog POSTs new content (cursor-based, only the bytes since last push) to the local sink (`http://127.0.0.1:9999/sink/<name>`):

```sh
tail -f .run/game-scb.log              # orchestrator cycle history (host-side)
tail -f .run/game-ollama-player.log    # AI action stream (host-side)
tail -f .run/game-gang.log             # gang manager
tail -f .run/game-bladeburner.log      # bladeburner manager
tail -f .run/game-sleeve.log           # sleeve manager
```

Ad-hoc pulls work via the in-game terminal: `download /logs/scb.txt`.

**Self-context loop:** `buildGameState` injects the last 30 lines of `/logs/ollama-player.txt` as `state.recentActions` so the model can see what it just did and avoid the "try the same forbidden upgrade 50 times in a row" failure mode. `state.jammedActions` lists `(action, reason)` pairs that failed 3+ times in a row — the prompt instructs the model to abandon them, and `safetyCheck` enforces it server-side.

**Progression signals.** `state.progression` carries `pendingAugs`, `installReady`, `pendingInvites`, `affordableAugs` (faction + aug + price + rep), and `factionsWithRep` (with `nextAugRepGap`). Without these the model would noop-spam once hack income saturates; the prompt instructs it to join factions, buy affordable augs, work the smallest rep gap, or `install_augmentations` — `noop` is the explicit last resort.

</details>

<details>
<summary><strong>🧰 Commands reference</strong></summary>
<br>

**Host-side (`./scb.sh`):**

| Command         | Effect                                                          |
|-----------------|-----------------------------------------------------------------|
| `start`         | filesync + scb-watch (NOT bridge)                               |
| `stop`          | All services (including bridge if running)                      |
| `restart`       | stop everything, then start filesync + watch                    |
| `status`        | Show running pids                                               |
| `logs`          | Tail all log files                                              |
| `sync`          | Only filesync                                                   |
| `bridge`        | Only the Claude bridge (opt-in)                                 |
| `watch`         | Only the file watcher                                           |
| `sync-all`      | Touch every `.js`/`.script`/`.txt` so filesync re-pushes them   |

**In-game terminal:**

```
run scb.js                                         # start the orchestrator
run scb.js --cleanup                               # archive deprecated scripts
run /approve-patch.js [--approve|--discard|--list] # AI patch review
run /ollama-actions.js --list                      # dump the action schema
```

</details>

<details>
<summary><strong>🛠️ Troubleshooting</strong></summary>
<br>

| Symptom                                          | Fix                                                                                          |
|--------------------------------------------------|----------------------------------------------------------------------------------------------|
| Hot-reload not firing                            | `tail -f .run/watch.log`. If you see `restart-marker bumped` but the game doesn't react, `kill /scb-watchdog.js && run /scb-watchdog.js`. |
| "Remote API offline" toast                       | Click *Connect* in the in-game panel. If it auto-disconnects repeatedly, `./scb.sh restart`. |
| Player spamming `fetch failed` warnings          | scb-watch hasn't found a reachable Ollama. Check `cat Temp/ollama-host.txt`.                  |
| Filesync `connected` but files not pushing       | Editor wrote via atomic-rename; chokidar can drop those events. `./scb.sh sync-all` re-pushes. |
| AI proposes same action 5+ times in a row        | The `recentActions` window is empty (likely `logAllActions: false`) — re-enable it.          |
| Bitburner says "X cannot be run because it does not have a main function" | You ran a library directly. `ollama-actions.js` has a stub `main` that prints help. |
| Bridge never starts                              | `claude --version` must work. If you use nvm/asdf, set `CLAUDE_BIN=/abs/path/to/claude` in `bridge/.env`. |

</details>

<details>
<summary><strong>📋 Requirements & Source-File gating</strong></summary>
<br>

**Required to run anything in this repo:**

* **Bitburner 3.0.0+** — uses `ns.cloud.*`, `ns.ui.openTail`, etc.
* **Source-File 4** (Singularity) — at any level. The orchestrator (`scb.js`) cannot start without it: it calls `ns.singularity.*` to buy the TOR router + port crackers, install backdoors, and execute every `work_*` / `study` / `gym` / `commit_crime` / `install_augmentations` / `soft_reset` / `travel` / `connect` / `buy_program` / `buy_augmentation` / `donate_faction` action.
* **Node ≥ 18** on the host (zero npm deps — pure stdlib).
* **Ollama** running somewhere reachable, OR `claude` CLI on PATH for the Claude-bridge backend.

**Optional Source-Files — features that gracefully no-op without them:**

| Source-File               | Gates              | Affected components                                                                          |
|---------------------------|--------------------|----------------------------------------------------------------------------------------------|
| **SF-2** (Gangs)          | `ns.gang.*`        | `gang-manager.js` idles cleanly. AI's `gang_recruit` / `gang_assign` / `gang_ascend` throw.  |
| **SF-6** (Bladeburners)   | `ns.bladeburner.*` | `bladeburner-manager.js` idles cleanly. AI's `bb_action` / `bb_skill` throw.                 |
| **SF-10** (Sleeves)       | `ns.sleeve.*`      | `sleeve-manager.js` cleanly idles. AI's `sleeve_task` and `set_sleeve_plan` actions throw.   |
| **SF-13** (Stanek's Gift) | `ns.stanek.*`      | Stanek companion only. `scb.js` auto-skips Stanek-dependent companions if Gift not accepted. |

On a fresh BN-1 install you have **none** of the optional SFs — disable the gang + bladeburner managers in `scb.js`:

```js
// scb.js
const FLAGS = {
  // ...
  companions: {
    "gang-manager.js":            false,   // needs SF-2
    "bladeburner-manager.js":     false,   // needs SF-6
    // ...
  }
};
```

The AI player itself runs without SF-2/6/10 — it just won't propose those gated actions in practice once it sees them rejected once.

</details>

---

## ☕ Support

I'm a disabled veteran who ships open-source projects in the gaps between appointments. If `scb` saved you some hours, sparked an idea you ran with, or just made you laugh once while tailing the logs —

* ⭐ **Star the repo.** Free, one click, genuinely the single most useful thing you can do. More stars = more Bitburner players find it.
* ☕ **[Buy me a coffee](https://buymeacoffee.com/jcinc)** — one-off, or a recurring membership if you really want to kit me out. Memberships fund the un-shippable work: safety audits, refactors, more model backends, more guard rails.
* 🍕 Buy enough coffees and I will absolutely upgrade one to a pizza. My dog will help eat it.

None of this is expected. The AI player keeps running either way. If you got genuine value out of this repo, a few seconds (the star) or a few bucks (the coffee) goes a long way. Either way — thanks for being here.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-jcinc-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jcinc)

---

## License

MIT — see [LICENSE](LICENSE).
