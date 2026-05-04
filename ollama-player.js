/**
 * ollama-player.js — Autonomous Bitburner AI Player
 * PLAYER_VERSION_8_PROGRAM_COST_SAFE
 */

import { ACTION_SCHEMA, validateAction, executeAction } from "/ollama-actions.js";

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

  // /Temp/ollama-host.txt is written by the local scb-watch daemon
  // after probing localhost + the LAN candidates. If present and
  // non-empty, it overrides whatever was passed in via config so the
  // player always points at a reachable endpoint.
  config.ollamaHost = resolveOllamaHost(ns, config.ollamaHost);

  const safety = parseJsonArg(ns.args[1], {
    maxActionsPerCycle: 5,
    minCashReserve: 1_000_000,
    minAugsToInstall: 5,
    requireConfirmForReset: true,
    blockedActions: ["soft_reset"],
    logAllActions: true,
    cashSpendCapPct: 90
  });

  ns.print("INFO  Ollama Player v8 — backend: " + config.backend);
  ns.print("INFO  ollamaHost: " + config.ollamaHost);
  ns.print("INFO  poll: " + config.pollInterval + "ms | maxActions: " + safety.maxActionsPerCycle);
  appendLog(ns, safety, `START backend=${config.backend} host=${config.ollamaHost} model=${config.ollamaModel}`);

  while (true) {
    try {
      // Re-resolve every cycle so the player follows a host coming
      // online or going offline mid-session.
      config.ollamaHost = resolveOllamaHost(ns, config.ollamaHost);

      const state = buildGameState(ns, safety);

      // Self-context: feed the last ~30 entries of our own action log
      // back into the prompt so the model can see what it just did and
      // avoid the "try the same forbidden upgrade 50 times in a row"
      // failure mode.
      const recent = readRecentLog(ns, 30);
      state.recentActions = recent;
      state.jammedActions = recentlyJammedActions(recent);

      const prompt = buildPrompt(state, safety);
      const actions = await askAI(ns, config, prompt);

      ns.print("INFO  AI returned " + actions.length + " action(s)");
      appendLog(ns, safety, `CYCLE money=${state.player.moneyFormatted} actions=${actions.length}`);

      let executed = 0;

      for (const action of actions) {
        if (executed >= safety.maxActionsPerCycle) break;

        const normalized = normalizeActionShape(action);
        const repaired = repairAction(ns, normalized);

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

        const result = await executeAction(ns, repaired);

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

function buildGameState(ns, safety) {
  const player = ns.getPlayer();
  const money = ns.getServerMoneyAvailable("home");
  const workers = getWorkerCapacity(ns);
  const programs = getOwnedPrograms(ns);
  const servers = scanAll(ns);
  const rooted = servers.filter((s) => ns.hasRootAccess(s));
  const targets = getTargets(ns, servers);
  const purchased = ns.cloud.getServerNames();
  const serverLimit = ns.cloud.getServerLimit();
  const atLimit = purchased.length >= serverLimit;
  const upgrades = getValidServerUpgrades(ns, money, safety);

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

    serverFleet: {
      ownedCount: purchased.length,
      limit: serverLimit,
      atLimit,
      maxRamLimit: ns.cloud.getRamLimit(),
      validUpgrades: upgrades
    },

    programs: {
      owned: programs,
      missing: getMissingPrograms(ns)
    },

    network: {
      totalServers: servers.length,
      rootedServers: rooted.length,
      rooted: rooted.slice(0, 50)
    },

    purchasedServers: purchased.map((s) => ({
      name: s,
      maxRam: ns.getServerMaxRam(s),
      usedRam: ns.getServerUsedRam(s),
      freeRam: freeRam(ns, s)
    })),

    workers,
    targets,
    recommendations: buildRecommendations(ns, workers, targets, programs, money, safety),

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

function buildRecommendations(ns, workers, targets, programs, money, safety) {
  const recommendations = [];

  const missing = getMissingPrograms(ns);
  const affordableProgram = missing.find((p) => money - p.cost >= safety.minCashReserve);

  if (affordableProgram) {
    recommendations.push({
      action: "buy_program",
      program: affordableProgram.name,
      reason: "Affordable missing hacking program"
    });
  }

  const owned = ns.cloud.getServerNames();
  const serverLimit = ns.cloud.getServerLimit();
  const atLimit = owned.length >= serverLimit;

  if (workers.totalFreeRam < workers.minHackRam) {
    if (!atLimit) {
      recommendations.push({
        action: "buy_server",
        ram: 8,
        reason: "No free worker RAM available and server slots remain"
      });
    }

    const upgrade = pickServerUpgrade(ns, money, safety);
    if (upgrade) {
      recommendations.push({
        action: "upgrade_server",
        server: upgrade.server,
        ram: upgrade.nextRam,
        reason: atLimit ? "Server limit reached. Upgrade existing server." : "Increase worker RAM"
      });
    }

    recommendations.push({
      action: "noop",
      reason: "RAM is full or constrained. Avoid failed deploy actions."
    });

    return recommendations;
  }

  const target = targets[0]?.name || "n00dles";

  if (workers.bestServer) {
    recommendations.push({
      action: "deploy_hack",
      target,
      server: workers.bestServer,
      reason: "Best target and available worker RAM"
    });
  }

  return recommendations;
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
    "- state.jammedActions lists (action, reason) pairs you've tried 3+ times in a row that all failed. NEVER propose any of those actions again this cycle.",
    "- If you see in state.jammedActions that upgrade_server is failing for cash reserve reasons, you cannot afford it — switch to deploy_hack, commit_crime, work_company, install_augmentations, or any income-generating action instead. Try again only after money grows.",
    "- If you see the same action succeed and you'd repeat it, only do so if the context has actually changed (e.g. a new server became available).",
    "- If you see a pattern in your log that looks like a code-level bug (the orchestrator or action library doing the wrong thing repeatedly), use read_file to inspect /ollama-actions.js or /ollama-player.js, then emit a propose_patch action so a human can review the fix. Do not write_generated_script in place of fixing core code; protected files require propose_patch.",
    "- You can also write helpful one-off helper scripts under /ai/generated/ via write_generated_script and run them via run_script if a specific automation would unblock you.",
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

async function askAI(ns, config, prompt) {
  if (config.backend === "ollama") return parseActions(await askOllama(ns, config, prompt));
  if (config.backend === "claude") return parseActions(await askClaudeBridge(ns, config, prompt));
  throw new Error("Unknown backend: " + config.backend);
}

async function askOllama(ns, config, prompt) {
  const url = trimSlash(config.ollamaHost) + "/api/generate";

  const body = {
    model: config.ollamaModel,
    prompt,
    stream: false,
    options: {
      temperature: 0.2,
      num_ctx: 8192
    }
  };

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, config.timeoutMs || 30_000);

    const data = await response.json();
    return data.response || "";
  } catch (err) {
    ns.print("WARN  fetch failed (" + String(err) + ") — trying ns.wget fallback");
    return await wgetFallback(ns, url, body);
  }
}

async function askClaudeBridge(ns, config, prompt) {
  const url = trimSlash(config.claudeHost);

  const body = {
    model: config.claudeModel,
    prompt
  };

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, config.timeoutMs || 30_000);

    const data = await response.json();
    return data.text || data.response || "";
  } catch (err) {
    ns.print("WARN  fetch failed (" + String(err) + ") — trying ns.wget fallback");
    return await wgetFallback(ns, url, body);
  }
}

async function wgetFallback(ns, url, body) {
  const file = "/Temp/ai-response.txt";
  const payload = "data:application/json," + encodeURIComponent(JSON.stringify(body));

  try {
    await ns.wget(payload, file);
    return ns.read(file) || "";
  } catch {
    return "";
  }
}

function parseActions(raw) {
  if (!raw || typeof raw !== "string") return [];

  let text = raw.trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");

  if (firstArray >= 0 && lastArray > firstArray) {
    text = text.slice(firstArray, lastArray + 1);
  } else {
    const firstObject = text.indexOf("{");
    const lastObject = text.lastIndexOf("}");

    if (firstObject >= 0 && lastObject > firstObject) {
      text = "[" + text.slice(firstObject, lastObject + 1) + "]";
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === "object");
    if (parsed && typeof parsed === "object") return [parsed];
    return [];
  } catch {
    return [];
  }
}

function normalizeActionShape(action) {
  if (!action || typeof action !== "object") return action;

  const normalized = { ...action };
  if (!Array.isArray(action.args)) return normalized;

  const args = action.args;

  if (action.action === "buy_server" && normalized.ram === undefined) normalized.ram = args[0];
  if (action.action === "upgrade_server") {
    if (normalized.server === undefined) normalized.server = args[0];
    if (normalized.ram === undefined) normalized.ram = args[1];
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

function repairAction(ns, action) {
  if (!action || typeof action !== "object") return action;

  const fixed = { ...action };

  if (fixed.action === "upgrade_server" && fixed.server) {
    const upgrade = getValidUpgradeForServer(ns, fixed.server);
    if (upgrade) fixed.ram = upgrade.nextRam;
  }

  return fixed;
}

function safetyCheck(ns, action, state, safety) {
  if (!action || typeof action !== "object") return { ok: false, reason: "invalid action object" };

  if (safety.blockedActions && safety.blockedActions.includes(action.action)) {
    return { ok: false, reason: "blocked action: " + action.action };
  }

  // Server-side jam suppression: even if the AI ignores the prompt
  // rules, we won't let it spam the same failing action 50× in a row.
  // state.jammedActions was computed from the recent log earlier this
  // cycle. If the proposed action matches a jammed signature, reject
  // with a clear "REPEAT-SUPPRESSED" reason that goes back into the
  // log and shows up in the next cycle's recentActions for the AI.
  if (Array.isArray(state.jammedActions) && state.jammedActions.length) {
    const sig = JSON.stringify(action);
    for (const j of state.jammedActions) {
      // j.sig is `{...action json...} :: <reason>` — match on the
      // action JSON prefix only, since the reason changes by run.
      const actionPart = j.sig.split(" :: ")[0];
      if (actionPart === sig) {
        return { ok: false, reason: "REPEAT-SUPPRESSED (" + j.count + "x): identical action just failed — try a different approach" };
      }
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

    if (money < program.cost) {
      return { ok: false, reason: "insufficient funds for " + action.program };
    }

    if (money - program.cost < safety.minCashReserve) {
      return { ok: false, reason: "purchase violates cash reserve" };
    }
  }

  if (["hack", "grow", "weaken", "deploy_hack"].includes(action.action)) {
    if (state.workers.totalFreeRam < state.workers.minHackRam) {
      return { ok: false, reason: "worker RAM exhausted" };
    }
  }

  if (action.action === "buy_server") {
    const owned = ns.cloud.getServerNames().length;
    const limit = ns.cloud.getServerLimit();

    if (owned >= limit) return { ok: false, reason: "server limit reached. Use upgrade_server instead." };

    const ram = sanitizeRam(Number(action.ram || 8));
    const cost = ns.cloud.getServerCost(ram);
    const cash = ns.getServerMoneyAvailable("home");

    if (cash - cost < safety.minCashReserve) {
      return { ok: false, reason: "buy_server would violate cash reserve" };
    }
  }

  if (action.action === "upgrade_server") {
    if (!action.server) return { ok: false, reason: "missing server" };

    const current = ns.getServerMaxRam(action.server);
    let ram = sanitizeRam(Number(action.ram || 0));

    if (ram <= current) ram = current * 2;
    ram = Math.min(ram, ns.cloud.getRamLimit());

    const cost = ram > current ? ns.cloud.getServerUpgradeCost(action.server, ram) : Infinity;

    if (cost < 0 || cost === Infinity) return { ok: false, reason: "invalid upgrade cost" };

    const cash = ns.getServerMoneyAvailable("home");

    if (cash - cost < safety.minCashReserve) {
      return { ok: false, reason: "upgrade_server would violate cash reserve" };
    }
  }

  if (action.action === "install_augmentations" && safety.requireConfirmForReset) {
    const queued = ns.singularity.getOwnedAugmentations(true).length;
    const owned = ns.singularity.getOwnedAugmentations(false).length;
    const pending = queued - owned;

    if (pending < safety.minAugsToInstall) {
      return { ok: false, reason: "not enough pending augmentations" };
    }
  }

  return { ok: true };
}

function getWorkerCapacity(ns) {
  const servers = [...new Set([...ns.cloud.getServerNames(), "home"])];

  const rows = servers.map((s) => {
    const maxRam = ns.getServerMaxRam(s);
    const usedRam = ns.getServerUsedRam(s);
    const reserve = s === "home" ? 256 : 0;
    const free = Math.max(0, maxRam - usedRam - reserve);

    return { server: s, maxRam, usedRam, reserve, freeRam: free };
  });

  const ranked = [...rows].sort((a, b) => b.freeRam - a.freeRam || b.maxRam - a.maxRam);
  const totalFreeRam = rows.reduce((sum, r) => sum + r.freeRam, 0);

  return {
    totalFreeRam,
    totalFreeRamFormatted: ns.format.ram(totalFreeRam),
    minHackRam: 8,
    bestServer: ranked[0]?.freeRam >= 8 ? ranked[0].server : null,
    servers: ranked
  };
}

function getTargets(ns, servers) {
  const player = ns.getPlayer();

  return servers
    .filter((s) => s !== "home")
    .filter((s) => !s.startsWith("hacknet"))
    .filter((s) => !s.startsWith("pserv"))
    .filter((s) => !s.startsWith("ai-pserv"))
    .filter((s) => ns.hasRootAccess(s))
    .filter((s) => ns.getServerMaxMoney(s) > 0)
    .filter((s) => ns.getServerRequiredHackingLevel(s) <= player.skills.hacking)
    .map((s) => {
      const maxMoney = ns.getServerMaxMoney(s);
      const money = ns.getServerMoneyAvailable(s);
      const minSec = ns.getServerMinSecurityLevel(s);
      const sec = ns.getServerSecurityLevel(s);
      const score = maxMoney / Math.max(1, minSec);

      return {
        name: s,
        maxMoney,
        money,
        moneyRatio: maxMoney > 0 ? money / maxMoney : 0,
        minSecurity: minSec,
        security: sec,
        requiredHacking: ns.getServerRequiredHackingLevel(s),
        score
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
}

function getOwnedPrograms(ns) {
  return PROGRAMS.filter((p) => ns.fileExists(p.name, "home")).map((p) => p.name);
}

function getMissingPrograms(ns) {
  return PROGRAMS.filter((p) => !ns.fileExists(p.name, "home"));
}

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

function getValidServerUpgrades(ns, money, safety) {
  const owned = ns.cloud.getServerNames();
  const maxRam = ns.cloud.getRamLimit();

  return owned
    .map((server) => {
      const current = ns.getServerMaxRam(server);
      const nextRam = Math.min(current * 2, maxRam);
      const cost = nextRam > current ? ns.cloud.getServerUpgradeCost(server, nextRam) : Infinity;

      return { server, current, nextRam, cost };
    })
    .filter((x) => x.nextRam > x.current)
    .filter((x) => x.cost > 0 && x.cost !== Infinity)
    .filter((x) => money - x.cost >= safety.minCashReserve)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 10);
}

function getValidUpgradeForServer(ns, server) {
  const maxRam = ns.cloud.getRamLimit();
  const current = ns.getServerMaxRam(server);
  const nextRam = Math.min(current * 2, maxRam);

  if (nextRam <= current) return null;

  const cost = ns.cloud.getServerUpgradeCost(server, nextRam);
  if (cost < 0 || cost === Infinity) return null;

  return { server, current, nextRam, cost };
}

function pickServerUpgrade(ns, money, safety) {
  const candidates = getValidServerUpgrades(ns, money, safety);
  return candidates[0] || null;
}

function scanAll(ns) {
  const visited = new Set();
  const queue = ["home"];

  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;

    visited.add(current);

    for (const next of ns.scan(current)) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return [...visited];
}

function sanitizeRam(value) {
  let ram = Number(value || 8);
  if (!Number.isFinite(ram) || ram < 8) ram = 8;
  return Math.max(8, Math.pow(2, Math.floor(Math.log2(ram))));
}

function parseJsonArg(raw, fallback) {
  if (!raw) return fallback;

  try {
    return { ...fallback, ...JSON.parse(String(raw)) };
  } catch {
    return fallback;
  }
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveOllamaHost(ns, fallback) {
  // The local scb-watch daemon writes /Temp/ollama-host.txt with the
  // first reachable Ollama endpoint (localhost or LAN). Use it if
  // present and non-empty; otherwise stick with the fallback baked
  // into config (or whatever the previous cycle resolved to).
  try {
    if (!ns.fileExists("/Temp/ollama-host.txt", "home")) return fallback;
    const detected = String(ns.read("/Temp/ollama-host.txt") || "").trim();
    if (!detected) return fallback;
    return detected;
  } catch (_) {
    return fallback;
  }
}

function freeRam(ns, server) {
  const reserve = server === "home" ? 256 : 0;
  return Math.max(0, ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserve);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── persistent action log ──────────────────────────────────────────
// .txt extension (not .log) so Bitburner's terminal `download` works
// — only .js/.script/.txt files can be downloaded from in-game.
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
      // Rotate to avoid pathological growth (and slow ns.read each cycle).
      ns.write(PLAYER_LOG_PREV, cur, "w");
      cur = "";
    }
    ns.write(PLAYER_LOG, cur + entry, "w");
  } catch (_) { /* swallow — logging must never crash the loop */ }
}

// Last N log entries — fed back into the prompt as `recentActions` so
// the model can see what it just did and avoid pathological loops.
function readRecentLog(ns, n) {
  try {
    if (!ns.fileExists(PLAYER_LOG, "home")) return [];
    const raw = ns.read(PLAYER_LOG);
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch (_) { return []; }
}

// Look at the last K outcomes and report any (action, reason) pair
// that has been rejected ≥ threshold times in a row. The system prompt
// tells the AI to stop proposing actions in this set.
function recentlyJammedActions(recent, { window = 30, threshold = 3 } = {}) {
  const tail = recent.slice(-window);
  const counts = new Map();
  for (const line of tail) {
    // Lines look like:
    //   2026-05-04T... SKIP  {"action":"upgrade_server",...} => upgrade_server would violate cash reserve
    //   2026-05-04T... OK    {"action":"deploy_hack",...} => deployed alpha-ent on ai-pserv-0 W:9362 ...
    const m = line.match(/\b(SKIP|FAIL)\s+(\{[^}]+\})\s+=>\s+(.+)$/);
    if (!m) continue;
    const sig = m[2] + " :: " + m[3];
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  const jammed = [];
  for (const [sig, n] of counts) {
    if (n >= threshold) jammed.push({ sig, count: n });
  }
  return jammed;
}