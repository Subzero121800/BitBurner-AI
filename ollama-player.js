/**
 * ollama-player.js — Autonomous Bitburner AI Player (slim caller)
 * PLAYER_VERSION_10_FETCH_OFFLOAD
 *
 * As of v9 the player no longer imports a fat dispatcher. Every
 * action is either:
 *   - inline (noop/wait/set_*_plan; pure JS plus one cheap write), or
 *   - routed by spawning a dispatcher under /ai/dispatch/<cat>.js,
 *     which pays its own namespace RAM cost for the few hundred ms
 *     it runs and then frees it.
 *
 * State that used to require the singularity / cloud namespaces in
 * this file is now consumed as JSON snapshots written by the helpers
 * in /ai/snap/. scb.js launches those snapshot scripts each cycle.
 *
 * Net effect: player static RAM drops from ~131 GB to ~6–8 GB.
 * See README → "RAM cost & limiting in-game memory".
 */

import { ACTION_SCHEMA, DISPATCH_MAP, INLINE_ACTIONS, validateAction } from "/ollama-actions.js";

const REQ_FILE = "/Temp/ai-action-req.json";
const RES_FILE = "/Temp/ai-action-res.json";

// Snapshot files written by /ai/snap/*.js
const NETWORK_SNAP     = "/Temp/network-state.json";
const CLOUD_SNAP       = "/Temp/cloud-state.json";
const PROGRESSION_SNAP = "/Temp/progression-state.json";

// If a snapshot is older than this, the player triggers a refresh by
// spawning the snap helper. The spawn cost is already in our budget;
// the snap script's RAM only materialises during its run.
const SNAP_STALE_MS = 90_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const config = parseJsonArg(ns.args[0], {
    backend:      "ollama",
    ollamaHost:   "http://127.0.0.1:11434",
    ollamaModel:  "llama3.1:8b",
    claudeHost:   "http://localhost:3000",
    claudeModel:  "sonnet",
    pollInterval: 60_000,
    timeoutMs:    30_000
  });
  config.ollamaHost = resolveOllamaHost(ns, config.ollamaHost);

  const safety = parseJsonArg(ns.args[1], {
    maxActionsPerCycle:    5,
    minCashReserve:        1_000_000,
    minAugsToInstall:      5,
    requireConfirmForReset:true,
    blockedActions:        ["soft_reset"],
    logAllActions:         true,
    cashSpendCapPct:       90
  });

  ns.print("INFO  Ollama Player v10 (fetch-offload) — backend: " + config.backend);
  ns.print("INFO  ollamaHost: " + config.ollamaHost);
  ns.print("INFO  poll: " + config.pollInterval + "ms | maxActions: " + safety.maxActionsPerCycle);
  appendLog(ns, safety, `START backend=${config.backend} host=${config.ollamaHost} model=${config.ollamaModel}`);

  // Publish a state snapshot so scb.js's ensureCompanionFresh can
  // version-bounce the player on disk-marker mismatch (same shape the
  // companion managers use). Without this, ensureRunning would happily
  // keep an old player alive across version bumps.
  publishState(ns, config);

  while (true) {
    try {
      config.ollamaHost = resolveOllamaHost(ns, config.ollamaHost);
      ensureSnapshotsFresh(ns);
      publishState(ns, config);

      const state = buildGameState(ns, safety);
      const recent = readRecentLog(ns, Number(config.recentLogLines) || 30);
      state.recentActions = recent;
      state.jammedActions = recentlyJammedActions(recent, {
        windowSize: Number(config.recentLogLines) || 30,
        threshold:  Number(config.jamThreshold)   || 3
      });

      const prompt = buildPrompt(state, safety);
      const actions = await askAI(ns, config, prompt);

      ns.print("INFO  AI returned " + actions.length + " action(s)");
      appendLog(ns, safety, `CYCLE money=${state.player.moneyFormatted} actions=${actions.length}`);

      let executed = 0;
      for (const action of actions) {
        if (executed >= safety.maxActionsPerCycle) break;
        const normalized = normalizeActionShape(action);
        const repaired = repairAction(state, normalized);

        const safe = safetyCheck(ns, repaired, state, safety);
        if (!safe.ok) {
          ns.print("SKIP  " + JSON.stringify(repaired) + " => " + safe.reason);
          appendLog(ns, safety, `SKIP  ${JSON.stringify(repaired)} => ${safe.reason}`);
          continue;
        }
        const valid = validateAction(repaired);
        if (!valid.ok) {
          ns.print("FAIL  " + JSON.stringify(repaired) + " => " + valid.reason);
          appendLog(ns, safety, `FAIL  ${JSON.stringify(repaired)} => ${valid.reason}`);
          continue;
        }

        const result = await dispatch(ns, repaired);
        const tag = result.success ? "OK    " : "FAIL  ";
        ns.print(tag + JSON.stringify(repaired) + " => " + result.result);
        appendLog(ns, safety, `${tag.trim()}  ${JSON.stringify(repaired)} => ${result.result}`);
        executed++;
      }
    } catch (err) {
      ns.print("ERROR  AI cycle failed: " + String(err));
      appendLog(ns, safety, `ERROR  cycle threw: ${String(err)}`);
    }
    await ns.sleep(config.pollInterval || 60_000);
  }
}

// ─── action dispatch ────────────────────────────────────────────────
//
// Inline actions (noop, wait, set_*_plan) are handled here directly —
// they don't justify the cost of a spawn round-trip. Everything else
// is routed via DISPATCH_MAP to /ai/dispatch/<cat>.js, spawned with
// the action object on /Temp/ai-action-req.json. The helper writes
// /Temp/ai-action-res.json and exits; we poll for it.
async function dispatch(ns, action) {
  if (INLINE_ACTIONS.has(action.action)) return runInline(ns, action);

  const cat = DISPATCH_MAP[action.action];
  if (!cat) return { success: false, result: "no dispatcher for " + action.action };

  const file = `/ai/dispatch/${cat}.js`;
  if (!ns.fileExists(file, "home")) {
    return { success: false, result: "dispatcher missing: " + file + " — run scb.js to repopulate" };
  }

  const reqId = String(Date.now()) + "-" + Math.floor(Math.random() * 1e6);
  const payload = { ...action, _reqId: reqId };
  ns.write(REQ_FILE, JSON.stringify(payload), "w");

  const pid = ns.exec(file, "home", 1);
  if (pid <= 0) return { success: false, result: `exec ${file} failed (RAM?)` };

  // Most dispatchers complete in well under 1s. backdoor + commit_crime
  // can take a few seconds; install_augmentations resets the game and
  // the result file may never land. 30s ceiling is plenty.
  for (let i = 0; i < 300; i++) {
    if (ns.fileExists(RES_FILE, "home")) {
      try {
        const parsed = JSON.parse(ns.read(RES_FILE) || "");
        if (parsed && parsed._reqId === reqId) return parsed;
      } catch (_) {}
    }
    await ns.sleep(100);
  }
  return { success: false, result: `dispatcher timeout (30s) on ${file}` };
}

function runInline(ns, action) {
  switch (action.action) {
    case "noop":
      return { success: true, result: "no-op" };
    case "wait":
      return { success: true, result: "wait acknowledged " + (Number(action.ms) || 0) + "ms" };
    case "set_sleeve_plan":
      return setDirective(ns, "/Temp/sleeve-directives.json", action.plan, "sleeve");
    case "set_gang_plan":
      return setDirective(ns, "/Temp/gang-directives.json", action.plan, "gang");
    case "set_bladeburner_plan":
      return setDirective(ns, "/Temp/bladeburner-directives.json", action.plan, "bladeburner");
    default:
      return { success: false, result: "inline: unhandled " + action.action };
  }
}

function setDirective(ns, path, plan, kind) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { success: false, result: kind + " plan must be a JSON object" };
  }
  const wrapped = { ...plan, ts: Date.now() };
  const body = JSON.stringify(wrapped, null, 2);
  if (body.length > 50_000) return { success: false, result: kind + " plan > 50 KB, refused" };
  try {
    ns.write(path, body, "w");
    return { success: true, result: "wrote " + kind + " directive (" + body.length + " B) to " + path };
  } catch (e) {
    return { success: false, result: "set_" + kind + "_plan threw: " + String(e.message || e) };
  }
}

// ─── snapshot bootstrap ─────────────────────────────────────────────
// scb.js runs the snap helpers each cycle, but on first launch (or
// after a watchdog bounce) the snapshots may be missing or stale. If
// so, we spawn the helper and let the next cycle pick up its output.
function ensureSnapshotsFresh(ns) {
  const snaps = [
    ["/ai/snap/network.js",     NETWORK_SNAP],
    ["/ai/snap/cloud.js",       CLOUD_SNAP],
    ["/ai/snap/progression.js", PROGRESSION_SNAP]
  ];
  for (const [helper, output] of snaps) {
    if (!ns.fileExists(helper, "home")) continue;
    let stale = true;
    try {
      if (ns.fileExists(output, "home")) {
        const ts = (JSON.parse(ns.read(output)) || {}).ts || 0;
        stale = (Date.now() - ts) > SNAP_STALE_MS;
      }
    } catch (_) {}
    if (stale) {
      try { ns.exec(helper, "home", 1); } catch (_) {}
    }
  }
}

// ─── game state assembly ────────────────────────────────────────────
function buildGameState(ns, safety) {
  const player = ns.getPlayer();
  const money = ns.getServerMoneyAvailable("home");
  const network = readJson(ns, NETWORK_SNAP) || { totalServers: 0, rootedServers: 0, rooted: [], targets: [] };
  const cloud   = readJson(ns, CLOUD_SNAP)   || { serverFleet: { ownedCount: 0, limit: 0, atLimit: false, maxRamLimit: 0, validUpgrades: [] },
                                                  purchasedServers: [], workers: { totalFreeRam: 0, minHackRam: 8, bestServer: null, servers: [] } };
  const progression = readJson(ns, PROGRESSION_SNAP) || {
    pendingAugs: 0, installedAugs: 0, installReady: false,
    pendingInvites: [], affordableAugs: [], factionsWithRep: []
  };

  const programs = getOwnedPrograms(ns);
  const missing  = getMissingPrograms(ns);

  return {
    time: new Date().toISOString(),

    player: {
      hacking: player.skills.hacking,
      city: player.city,
      money,
      moneyFormatted: ns.format.number(money),
      factions: player.factions || [],
      jobs: player.jobs || {}
    },

    safety: {
      minCashReserve: safety.minCashReserve,
      spendableCash: Math.max(0, money - safety.minCashReserve)
    },

    savings: {
      target:    Number(safety.savingsTarget || 0),
      floor:     Number(safety.minCashReserve || 0),
      threshold: Number(safety.minCashReserve || 0) + Number(safety.savingsTarget || 0),
      cash:      money,
      shortBy:   Math.max(0, (Number(safety.minCashReserve || 0) + Number(safety.savingsTarget || 0)) - money),
      unlocked:  money >= (Number(safety.minCashReserve || 0) + Number(safety.savingsTarget || 0))
    },

    systemHealth: getSystemHealth(ns),
    budget:       getBudget(ns),

    managers: {
      sleeve:      readJson(ns, "/Temp/sleeve-state.json"),
      gang:        readJson(ns, "/Temp/gang-state.json"),
      bladeburner: readJson(ns, "/Temp/bladeburner-state.json")
    },

    serverFleet:      cloud.serverFleet,
    purchasedServers: cloud.purchasedServers,
    workers:          cloud.workers,

    programs:     { owned: programs, missing },
    progression,

    network: {
      totalServers:  network.totalServers,
      rootedServers: network.rootedServers,
      rooted:        network.rooted
    },
    targets: network.targets,

    recommendations: buildRecommendations(cloud, network, missing, money, safety),

    rules: [
      "Return only raw JSON. No markdown. No explanation.",
      "Return an array of action objects.",
      "Use named fields, not args arrays.",
      "Do not use buy_server if serverFleet.atLimit is true.",
      "If serverFleet.atLimit is true and more RAM is needed, choose upgrade_server from serverFleet.validUpgrades.",
      "For upgrade_server, use only a ram value listed in serverFleet.validUpgrades.",
      "Do not request an upgrade to a RAM value lower than or equal to the server's current RAM.",
      "Do not deploy hack/grow/weaken if workers.totalFreeRam < workers.minHackRam.",
      "If RAM is full, choose noop, wait, upgrade_server, buy_program, commit_crime, study, gym, faction, or hacknet actions.",
      "Do not buy a program already listed in programs.owned.",
      "Only choose buy_program if safety.spendableCash is greater than or equal to the program cost.",
      "If a program is too expensive, choose noop, wait, deploy_hack, or upgrade_server instead.",
      "Prefer upgrade_server when serverFleet.atLimit is true.",
      "Prefer weaken or deploy_hack only when workers.bestServer has enough free RAM.",
      "Do not call soft_reset unless explicitly useful and not blocked."
    ],

    actionSchema: ACTION_SCHEMA
  };
}

function buildRecommendations(cloud, network, missing, money, safety) {
  const recs = [];
  const fleet = cloud.serverFleet || { atLimit: false, validUpgrades: [] };
  const workers = cloud.workers || { totalFreeRam: 0, minHackRam: 8, bestServer: null };

  const affordable = (missing || []).find((p) => money - p.cost >= safety.minCashReserve);
  if (affordable) {
    recs.push({ action: "buy_program", program: affordable.name, reason: "Affordable missing hacking program" });
  }

  if (workers.totalFreeRam < workers.minHackRam) {
    if (!fleet.atLimit) {
      recs.push({ action: "buy_server", ram: 8, reason: "No free worker RAM available and server slots remain" });
    }
    const up = (fleet.validUpgrades || [])[0];
    if (up) {
      recs.push({
        action: "upgrade_server", server: up.server, ram: up.nextRam,
        reason: fleet.atLimit ? "Server limit reached. Upgrade existing server." : "Increase worker RAM"
      });
    }
    recs.push({ action: "noop", reason: "RAM is full or constrained. Avoid failed deploy actions." });
    return recs;
  }

  const target = (network.targets && network.targets[0]?.name) || "n00dles";
  if (workers.bestServer) {
    recs.push({
      action: "deploy_hack", target, server: workers.bestServer,
      reason: "Best target and available worker RAM"
    });
  }
  return recs;
}

function buildPrompt(state, safety) {
  return [
    "You are an autonomous Bitburner player.",
    "Choose useful actions based only on the provided JSON game state.",
    "",
    "Critical rules:",
    "- Return only raw JSON.",
    "- Return an array of action objects.",
    "- Use named properties, not args arrays.",
    "- Maximum actions this cycle: " + safety.maxActionsPerCycle,
    "- Never repeat actions that are already satisfied.",
    "- Do not buy programs already owned.",
    "- Only buy programs listed as affordable by recommendations or whose cost is below safety.spendableCash.",
    "- Do not use buy_server when serverFleet.atLimit is true.",
    "- If serverFleet.atLimit is true and RAM is needed, use upgrade_server from serverFleet.validUpgrades.",
    "- For upgrade_server, use exact server and ram values from serverFleet.validUpgrades.",
    "- Do not deploy workers when total free RAM is too low.",
    "- If RAM is full, upgrade servers, wait, or noop.",
    "- Prefer safe, incremental progress.",
    "",
    "Self-correction rules (READ THIS FIRST):",
    "- state.recentActions contains your own log of recently-attempted actions.",
    "- state.jammedActions lists (action, reason) pairs you've tried multiple times in a row that all failed. NEVER propose any of those actions again this cycle.",
    "- If you see in state.jammedActions that upgrade_server is failing for cash reserve reasons, you cannot afford it — switch to deploy_hack, commit_crime, work_company, install_augmentations, or any income-generating action instead. Try again only after money grows.",
    "- If you see the same action succeed and you'd repeat it, only do so if the context has actually changed (e.g. a new server became available).",
    "- If you see a pattern in your log that looks like a code-level bug (the orchestrator or action library doing the wrong thing repeatedly), use read_file to inspect /ollama-actions.js or /ollama-player.js, then emit a propose_patch action so a human can review the fix. Do not write_generated_script in place of fixing core code; protected files require propose_patch.",
    "- You can also write helpful one-off helper scripts under /ai/generated/ via write_generated_script and run them via run_script if a specific automation would unblock you.",
    "",
    "Progression policy (avoid noop-spamming once income saturates):",
    "- state.progression.pendingInvites lists factions you have NOT joined yet. For each, emit join_faction immediately — there is no downside.",
    "- state.progression.affordableAugs lists augs you can buy RIGHT NOW from factions you've already joined (rep + cash both met). When this array is non-empty AND state.savings.unlocked is true, prefer buy_augmentation over noop. Use the {faction, aug} pair verbatim.",
    "- state.progression.installReady is true when you have ≥ 5 queued augs. When installReady is true and state.progression.affordableAugs is empty (or you've bought what you can), emit install_augmentations to lock in your gains and reset.",
    "- state.progression.factionsWithRep[].nextAugRepGap is the rep delta to the next aug. If it's small (< 25k) and you have nothing else to buy, work_faction with that faction to close the gap — don't sit idle.",
    "- noop is only acceptable when ALL of: savings unlocked is false, RAM is full, no affordable augs, no pending invites, no faction with a small rep gap, and recentActions shows the same income-action already in flight. Otherwise pick something concrete.",
    "",
    "Savings policy (READ THIS):",
    "- state.savings.threshold = minCashReserve + savingsTarget. While state.savings.unlocked == false, all discretionary spending is blocked server-side: buy_program, buy_server, upgrade_server, buy_augmentation, donate_faction will all be rejected with SAVINGS-LOCKED.",
    "- When state.savings.unlocked == false, focus exclusively on income generation: deploy_hack against the highest-value targets in state.targets, commit_crime, work_company, work_faction, study, gym, hacknet purchases/upgrades, or noop/wait if RAM is full.",
    "- When state.savings.unlocked == true, spending is allowed up to safety.cashSpendCapPct of starting-cycle cash; prefer upgrades + augs that compound future income.",
    "",
    "System health (HIGHEST PRIORITY — read this BEFORE picking actions):",
    "- state.systemHealth.syncStale: when true the host can no longer deliver fresh code into the game (the heartbeat file has gone stale). The state you're seeing may be hours old.",
    "- When syncStale is true, your ENTIRE response must be exactly: [{\"action\":\"reconnect_remote_api\"}] — nothing else. Don't deploy, don't buy, don't propose patches. The reconnect action calls the in-game DOM to click Options→Remote API→Connect. After it succeeds, normal cycles resume.",
    "- When syncStale is false, ignore reconnect_remote_api entirely.",
    "",
    "Manager steering (autonomous companions you can override):",
    "- state.managers.{sleeve, gang, bladeburner} is each manager's per-cycle state snapshot (null if it isn't running). Use it to decide whether to override their default behaviour.",
    "- To steer them, emit set_sleeve_plan / set_gang_plan / set_bladeburner_plan with a `plan` object. The directive expires after 10 minutes if you don't refresh, so the manager falls back to defaults if you go silent.",
    "- Example sleeve plan: {default:{task:'commit_crime',crime:'Homicide'},sleeves:{0:{task:'synchronize'}}}",
    "- Example gang plan: {memberOverrides:{Alpha:'Vigilante Justice'},allowEquipment:false,warfareOverride:false}",
    "- Example bladeburner plan: {actionOverride:{type:'Operation',name:'Assassination'},antiChaosThreshold:30}",
    "- Don't set a plan if the manager's default is doing the right thing — overrides are for when you have specific strategic intent.",
    "",
    "RAM budget (only relevant if state.budget.capped is true):",
    "- state.budget.maxInGameRamGB is the user's cap on home-side scripts.",
    "- state.budget.managedRamGB is what's currently used by spawned scripts (excludes scb.js itself).",
    "- state.budget.budgetRemainingGB is the headroom left.",
    "- If state.budget.tight is true, do NOT propose write_generated_script + run_script that would launch a new home-side worker. Pick income actions that use existing capacity (deploy_hack to pserv-N, work_company, commit_crime, etc.).",
    "- If state.budget.capped is false (unlimited), ignore this section.",
    "",
    "Filesystem rules:",
    "- write_generated_script and delete_generated_script only work under /ai/generated/, /ai/scratch/, /Temp/, /logs/. Anywhere else is rejected.",
    "- run_script can only execute files in those same dirs. To deploy a worker you wrote, run it from /ai/generated/.",
    "- copy_script: source must be in the allowed dirs, dst must be a rooted server.",
    "- To change a PROTECTED file (scb.js / ollama-player.js / ollama-actions.js / scb-watchdog.js / hack.js / grow.js / weaken.js / helpers.js / autopilot.js / contractor.js / server-upgrader.js): emit a propose_patch action with target/content/reason. A human approves it via /approve-patch.js — do NOT call write_generated_script for protected files.",
    "- read_file and list_files are unrestricted; use them to inspect state before proposing changes.",
    "",
    "Required response format:",
    "[{\"action\":\"noop\"}]",
    "",
    "Good examples:",
    "[{\"action\":\"upgrade_server\",\"server\":\"pserv-0\",\"ram\":8192}]",
    "[{\"action\":\"deploy_hack\",\"target\":\"summit-uni\",\"server\":\"pserv-0\"}]",
    "",
    "Bad examples:",
    "[{\"action\":\"buy_server\",\"args\":[2048]}]",
    "[{\"action\":\"upgrade_server\",\"server\":\"pserv-0\",\"ram\":4096}] if pserv-0 already has 4096GB or more",
    "[{\"action\":\"buy_program\",\"program\":\"BruteSSH.exe\"}] when already owned",
    "",
    "Game state:",
    JSON.stringify(state)
  ].join("\n");
}

// ─── AI backend ─────────────────────────────────────────────────────
async function askAI(ns, config, prompt) {
  if (config.backend === "ollama") return parseActions(await askOllama(ns, config, prompt));
  if (config.backend === "claude") return parseActions(await askClaudeBridge(ns, config, prompt));
  throw new Error("Unknown backend: " + config.backend);
}

async function askOllama(ns, config, prompt) {
  const url = trimSlash(config.ollamaHost) + "/api/generate";
  const body = JSON.stringify({
    model: config.ollamaModel,
    prompt,
    stream: false,
    options: {
      temperature: typeof config.temperature === "number" ? config.temperature : 0.2,
      num_ctx:     typeof config.numCtx       === "number" ? config.numCtx       : 8192
    }
  });
  try {
    const result = await postViaHelper(ns, url, body, config.timeoutMs || 30_000);
    if (!result.ok) {
      ns.print("WARN  ai-fetch error: " + (result.error || ("status " + result.status)));
      return "";
    }
    const data = JSON.parse(result.text || "{}");
    return data.response || "";
  } catch (err) {
    ns.print("WARN  askOllama threw: " + String(err));
    return "";
  }
}

async function askClaudeBridge(ns, config, prompt) {
  const url = trimSlash(config.claudeHost);
  const body = JSON.stringify({ model: config.claudeModel, prompt });
  try {
    const result = await postViaHelper(ns, url, body, config.timeoutMs || 30_000);
    if (!result.ok) {
      ns.print("WARN  ai-fetch error: " + (result.error || ("status " + result.status)));
      return "";
    }
    const data = JSON.parse(result.text || "{}");
    return data.text || data.response || "";
  } catch (err) {
    ns.print("WARN  askClaudeBridge threw: " + String(err));
    return "";
  }
}

// Routes the HTTP call through /helpers/ai-fetch.js so the resident
// player doesn't carry the global fetch / AbortController RAM cost
// (~25 GB in modern Bitburner). The helper materialises that cost
// only for the duration of the round-trip and then frees it.
async function postViaHelper(ns, url, body, timeoutMs) {
  const helper = "/helpers/ai-fetch.js";
  if (!ns.fileExists(helper, "home")) {
    return { ok: false, error: "missing " + helper + " — sync the helpers/ dir from the repo" };
  }
  const reqId = String(Date.now()) + "-" + Math.floor(Math.random() * 1e6);
  const REQ = "/Temp/ai-fetch-req.json";
  const RES = "/Temp/ai-fetch-res.json";

  ns.write(REQ, JSON.stringify({
    _reqId: reqId,
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs
  }), "w");

  const pid = ns.exec(helper, "home", 1);
  if (pid <= 0) return { ok: false, error: "ai-fetch exec failed (RAM?)" };

  // Poll for the matching response. Worst case we wait timeoutMs+5s.
  const ceiling = (timeoutMs || 30_000) + 5_000;
  const slices  = Math.max(10, Math.ceil(ceiling / 200));
  for (let i = 0; i < slices; i++) {
    if (ns.fileExists(RES, "home")) {
      try {
        const parsed = JSON.parse(ns.read(RES) || "");
        if (parsed && parsed._reqId === reqId) return parsed;
      } catch (_) {}
    }
    await ns.sleep(200);
  }
  return { ok: false, error: "ai-fetch timeout (" + ceiling + "ms)" };
}

function parseActions(raw) {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
  const firstArray = text.indexOf("[");
  const lastArray  = text.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    text = text.slice(firstArray, lastArray + 1);
  } else {
    const firstObject = text.indexOf("{");
    const lastObject  = text.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) text = "[" + text.slice(firstObject, lastObject + 1) + "]";
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === "object");
    if (parsed && typeof parsed === "object") return [parsed];
    return [];
  } catch { return []; }
}

function normalizeActionShape(action) {
  if (!action || typeof action !== "object") return action;
  const normalized = { ...action };
  if (action.args && typeof action.args === "object" && !Array.isArray(action.args)) {
    for (const [k, v] of Object.entries(action.args)) {
      if (k === "action") continue;
      if (normalized[k] === undefined) normalized[k] = v;
    }
    delete normalized.args;
    return normalized;
  }
  if (!Array.isArray(action.args)) return normalized;
  const args = action.args;
  if (action.action === "buy_server" && normalized.ram === undefined) normalized.ram = args[0];
  if (action.action === "upgrade_server") {
    if (normalized.server === undefined) normalized.server = args[0];
    if (normalized.ram === undefined)    normalized.ram    = args[1];
  }
  if (action.action === "deploy_hack") {
    if (normalized.target === undefined) normalized.target = args[0];
    if (normalized.server === undefined) normalized.server = args[1];
  }
  if (["hack", "grow", "weaken"].includes(action.action) && normalized.target === undefined) normalized.target = args[0];
  if (action.action === "buy_program" && normalized.program === undefined) normalized.program = args[0];
  delete normalized.args;
  return normalized;
}

// repairAction now takes the snapshot-based state instead of calling the cloud namespace directly.
function repairAction(state, action) {
  if (!action || typeof action !== "object") return action;
  const fixed = { ...action };
  if (fixed.action === "upgrade_server" && fixed.server) {
    const valid = state.serverFleet?.validUpgrades || [];
    const match = valid.find((u) => u.server === fixed.server);
    if (match) fixed.ram = match.nextRam;
  }
  return fixed;
}

function safetyCheck(ns, action, state, safety) {
  if (!action || typeof action !== "object") return { ok: false, reason: "invalid action object" };

  if (safety.blockedActions && safety.blockedActions.includes(action.action)) {
    return { ok: false, reason: "blocked action: " + action.action };
  }

  if (Array.isArray(state.jammedActions) && state.jammedActions.length) {
    const sig = JSON.stringify(action);
    for (const j of state.jammedActions) {
      const actionPart = j.sig.split(" :: ")[0];
      if (actionPart === sig) {
        return { ok: false, reason: "REPEAT-SUPPRESSED (" + j.count + "x): identical action just failed — try a different approach" };
      }
    }
  }

  if (state.savings && state.savings.target > 0 && !state.savings.unlocked) {
    const DISCRETIONARY = new Set([
      "buy_program", "buy_server", "upgrade_server",
      "buy_augmentation", "donate_faction"
    ]);
    if (DISCRETIONARY.has(action.action)) {
      const short = state.savings.shortBy;
      return {
        ok: false,
        reason: "SAVINGS-LOCKED: cash is $" + short.toLocaleString() +
                " short of savings target ($" + state.savings.threshold.toLocaleString() +
                "). Earn first; discretionary spend is paused."
      };
    }
  }

  if (action.action === "buy_program") {
    if (!action.program) return { ok: false, reason: "missing program" };
    if (state.programs.owned.includes(action.program)) {
      return { ok: false, reason: action.program + " already owned" };
    }
    const program = PROGRAMS.find((p) => p.name === action.program);
    if (!program) return { ok: false, reason: "unknown program" };
    const money = ns.getServerMoneyAvailable("home");
    if (money < program.cost) return { ok: false, reason: "insufficient funds for " + action.program };
    if (money - program.cost < safety.minCashReserve) return { ok: false, reason: "purchase violates cash reserve" };
  }

  if (["hack", "grow", "weaken", "deploy_hack"].includes(action.action)) {
    if (state.workers.totalFreeRam < state.workers.minHackRam) {
      return { ok: false, reason: "worker RAM exhausted" };
    }
  }

  if (action.action === "buy_server") {
    if (state.serverFleet.atLimit) return { ok: false, reason: "server limit reached. Use upgrade_server instead." };
    // Cost gating happens inside the dispatcher with live values; here we only
    // gate on snapshot data so the dispatcher isn't even spawned for a clear no.
  }

  if (action.action === "upgrade_server") {
    if (!action.server) return { ok: false, reason: "missing server" };
    const valid = (state.serverFleet.validUpgrades || []).find((u) => u.server === action.server);
    if (!valid) return { ok: false, reason: "no valid upgrade for " + action.server + " in current fleet snapshot" };
    const money = ns.getServerMoneyAvailable("home");
    if (money - valid.cost < safety.minCashReserve) {
      return { ok: false, reason: "upgrade_server would violate cash reserve" };
    }
  }

  if (action.action === "install_augmentations" && safety.requireConfirmForReset) {
    const pending = state.progression?.pendingAugs || 0;
    if (pending < safety.minAugsToInstall) {
      return { ok: false, reason: "not enough pending augmentations" };
    }
  }

  return { ok: true };
}

// ─── helpers ────────────────────────────────────────────────────────
function getOwnedPrograms(ns)   { return PROGRAMS.filter((p) =>  ns.fileExists(p.name, "home")).map((p) => p.name); }
function getMissingPrograms(ns) { return PROGRAMS.filter((p) => !ns.fileExists(p.name, "home")); }

const PROGRAMS = [
  { name: "BruteSSH.exe", cost: 500_000 },
  { name: "FTPCrack.exe", cost: 1_500_000 },
  { name: "relaySMTP.exe", cost: 5_000_000 },
  { name: "HTTPWorm.exe", cost: 30_000_000 },
  { name: "SQLInject.exe", cost: 250_000_000 },
  { name: "ServerProfiler.exe", cost: 500_000 },
  { name: "DeepscanV1.exe", cost: 500_000 },
  { name: "DeepscanV2.exe", cost: 25_000_000 },
  { name: "AutoLink.exe", cost: 1_000_000 },
  { name: "Formulas.exe", cost: 5_000_000_000 }
];

function parseJsonArg(raw, fallback) {
  if (!raw) return fallback;
  try { return { ...fallback, ...JSON.parse(String(raw)) }; }
  catch { return fallback; }
}

function trimSlash(value) { return String(value || "").replace(/\/+$/, ""); }

function resolveOllamaHost(ns, fallback) {
  try {
    if (!ns.fileExists("/Temp/ollama-host.txt", "home")) return fallback;
    const detected = String(ns.read("/Temp/ollama-host.txt") || "").trim();
    return detected || fallback;
  } catch (_) { return fallback; }
}

function readJson(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return null;
    return JSON.parse(ns.read(path)) || null;
  } catch (_) { return null; }
}

function publishState(ns, config) {
  try {
    ns.write("/Temp/ollama-player-state.json", JSON.stringify({
      ts: Date.now(),
      version:    "PLAYER_VERSION_10_FETCH_OFFLOAD",
      backend:    config.backend,
      ollamaHost: config.ollamaHost,
      model:      config.backend === "claude" ? config.claudeModel : config.ollamaModel
    }, null, 2), "w");
  } catch (_) {}
}

function getBudget(ns) {
  try {
    if (!ns.fileExists("/Temp/economy.json", "home")) return null;
    const econ = JSON.parse(ns.read("/Temp/economy.json")) || {};
    return {
      maxInGameRamGB:    econ.maxInGameRamGB || 0,
      managedRamGB:      econ.managedRamGB || 0,
      budgetRemainingGB: econ.budgetRemainingGB,
      capped:            (econ.maxInGameRamGB || 0) > 0,
      tight:             (econ.maxInGameRamGB || 0) > 0 &&
                         (econ.budgetRemainingGB ?? Infinity) < 4
    };
  } catch (_) { return null; }
}

function getSystemHealth(ns) {
  let heartbeatAgeMs = Infinity;
  try {
    if (ns.fileExists("/Temp/scb-heartbeat.txt", "home")) {
      const beat = Number(String(ns.read("/Temp/scb-heartbeat.txt") || "").trim());
      if (beat) heartbeatAgeMs = Date.now() - beat;
    }
  } catch (_) {}
  const syncStale = !isFinite(heartbeatAgeMs) || heartbeatAgeMs > 15_000;
  return {
    syncStale,
    heartbeatAgeSec: isFinite(heartbeatAgeMs) ? Math.round(heartbeatAgeMs / 1000) : null,
    advice: syncStale
      ? "Remote API appears disconnected. Emit a single reconnect_remote_api action this cycle. Skip business actions until sync recovers — deploys won't survive the next code update anyway."
      : "Remote API healthy. Proceed with normal action selection."
  };
}

// ─── persistent action log ──────────────────────────────────────────
const PLAYER_LOG = "/logs/ollama-player.txt";
const PLAYER_LOG_PREV = "/logs/ollama-player.1.txt";
const PLAYER_LOG_MAX_BYTES = 256_000;

function appendLog(ns, safety, line) {
  if (!safety.logAllActions) return;
  try {
    const ts = new Date().toISOString();
    const entry = ts + " " + String(line).replace(/\s+$/, "") + "\n";
    let cur = ns.fileExists(PLAYER_LOG, "home") ? ns.read(PLAYER_LOG) : "";
    if (cur.length + entry.length > PLAYER_LOG_MAX_BYTES) {
      ns.write(PLAYER_LOG_PREV, cur, "w");
      cur = "";
    }
    ns.write(PLAYER_LOG, cur + entry, "w");
  } catch (_) {}
}

function readRecentLog(ns, n) {
  try {
    if (!ns.fileExists(PLAYER_LOG, "home")) return [];
    const raw = ns.read(PLAYER_LOG);
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch (_) { return []; }
}

function recentlyJammedActions(recent, { windowSize = 30, threshold = 3 } = {}) {
  const tail = recent.slice(-windowSize);
  const counts = new Map();
  for (const line of tail) {
    const m = line.match(/\b(SKIP|FAIL)\s+(\{[^}]+\})\s+=>\s+(.+)$/);
    if (!m) continue;
    const sig = m[2] + " :: " + m[3];
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  const jammed = [];
  for (const [sig, n] of counts) if (n >= threshold) jammed.push({ sig, count: n });
  return jammed;
}
