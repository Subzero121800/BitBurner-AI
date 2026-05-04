/**
 * scb.js — Master Orchestrator
 * Bitburner 3.0.0 compatible
 * SCB_VERSION_11_SINGLETON_RUNNER
 */

const FLAGS = {
  // Core orchestrator
  scanAndRoot:       true,
  backdoor:          true,
  buyTor:            true,
  buyPrograms:       true,
  serverUpgrader:    true,
  deployHackScripts: true,
  autoContracts:     true,

  // Hot-reload watchdog (paired with the local scb-watch daemon)
  watchdog:          true,

  // RAM budget on home for everything we spawn (companions, AI
  // player, auto-generated workers). 0 = unlimited / use whatever
  // is free. scb.js itself is exempt — without it nothing can
  // launch. Workers deployed to PURCHASED servers (hack/grow/
  // weaken on pservs) don't count against this cap; only home
  // RAM does. This exists so people with smaller home setups can
  // run the orchestrator + a couple of companions without trying
  // to launch a $66 GB stack on a $32 GB home.
  //
  // Suggested values:
  //   0     unlimited (current behaviour)
  //   16    fresh save / pre-augmentation runs (orchestrator + watchdog)
  //   48    add the AI player (deepseek-coder-v2:16b)
  //   96    add gang-manager + bladeburner-manager
  maxInGameRamGB:    0,

  // Autonomous AI player (Ollama backend — local or LAN endpoint)
  ollamaPlayer:      true,

  // Bring-your-own-companions launcher.
  //
  // scb.js doesn't ship the companion scripts — you provide them
  // yourself (the Bryden / Insight framework is the most common
  // source). scb.js calls ns.fileExists(name, "home") before each
  // launch and silently skips anything missing, so a partial set
  // is fine. Toggle `false` to keep an entry but disable it.
  //
  // To wire up your own helpers: drop the .js into the workspace,
  // add a `"yourscript.js": true` line below, save. The watchdog
  // will hot-reload scb.js and launch it on the next cycle.
  launchCompanions:  true,
  companions: {
    // Bryden orchestrator — turn ON to delegate everything; turn
    // OFF to drive with the individual managers below. Don't enable
    // both at once — scb.js prints a conflict warning if you do.
    "autopilot.js":               false,

    // Our own managers (ship in this repo, no external deps).
    // All three are autonomous with safe defaults AND can be steered
    // by the AI player via /Temp/<manager>-directives.json
    // (set_sleeve_plan / set_gang_plan / set_bladeburner_plan).
    "gang-manager.js":            true,    // gang autopilot — needs SF-2
    "bladeburner-manager.js":     true,    // bladeburner autopilot — needs SF-6
    "sleeve-manager.js":          true,    // sleeve autopilot — needs SF-10

    // Individual managers (user-supplied; skipped silently if missing)
    "stats.js":                   true,
    "stockmaster.js":             false,
    "sleeve.js":                  false,
    "faction-manager.js":         false,
    "hacknet-upgrade-manager.js": true,
    "host-manager.js":            false,
    "spend-hacknet-hashes.js":    true,

    // Hacking workers (the per-server hack/grow/weaken scripts run
    // automatically via FLAGS.deployHackScripts; these are
    // standalone managers that some frameworks ship)
    "hackall.js":                 false,
    "n00dles.js":                 false,

    // Stanek (auto-skipped if Gift not accepted)
    "stanek.js":                  true,

    // The AI player is launched separately via FLAGS.ollamaPlayer
    // — leave this false to avoid double-spawn.
    "ollama-player.js":           false
  }
};

const COMPANION_ARGS = {
  "spend-hacknet-hashes.js": ["-l"]
};

const COMPANION_NEEDS_STANEK = new Set(["stanek.js", "charge.js"]);

// AI_CONFIG.ollamaHost is just a fallback. The real value is read on
// every cycle from /Temp/ollama-host.txt, which the local scb-watch
// daemon writes after probing the candidates listed in
// watch/ollama-candidates.json (or 127.0.0.1 if that file is absent).
const AI_CONFIG = {
  // ── Connectivity ─────────────────────────────────────────────────
  backend:      "ollama",
  ollamaHost:   "http://127.0.0.1:11434",
  // deepseek-coder-v2:16b is a coding-tuned model that's strong
  // enough to read /ollama-actions.js, /ollama-player.js and emit
  // coherent propose_patch payloads — the 8B fallback couldn't.
  // Swap to llama3.1:70b or qwen2.5-coder:32b on a beefier box.
  ollamaModel:  "deepseek-coder-v2:16b",
  claudeHost:   "http://localhost:3000",
  claudeModel:  "sonnet",
  // 5-minute poll — the AI is the strategic layer; tactical work
  // (root, backdoor, deploy) runs every 30 s in scb.js anyway.
  // savings + jam-suppression keep it from doing anything dumb
  // between cycles. Drop to 60-120 s if you want faster reactions.
  pollInterval: 300_000,
  // 16B-class inferences run ~30-60 s on most hardware. 30 s
  // would constantly abort.
  timeoutMs:     90_000,

  // ── Model tuning ─────────────────────────────────────────────────
  // Sampling temp: 0.0 = deterministic, 0.7 = creative. Low is
  // generally better for actuator-style agents.
  temperature:  0.2,
  // Ollama context window — increase if recentActions starts getting
  // truncated in your model's context.
  numCtx:       8192,

  // ── Self-context tuning ──────────────────────────────────────────
  // How many recent /logs/ollama-player.txt lines to feed back into
  // the prompt as state.recentActions.
  recentLogLines: 30,
  // How many times an identical (action, reason) pair must appear
  // in the recent window before it's added to state.jammedActions
  // and rejected by safetyCheck before it ever reaches the model.
  jamThreshold:   3
};

// ─── Economy / safety policy ────────────────────────────────────────
// Two cash floors with different jobs:
//   • minCashReserve — HARD floor. Any action that would drop liquid
//     home cash below this is rejected. Survival money.
//   • savingsTarget  — SOFT target. While liquid cash is below
//     (minCashReserve + savingsTarget), discretionary spending
//     (buy_program, buy_server, upgrade_server, buy_augmentation,
//     donate_faction) is blocked. Income-earning actions still run.
//     Once savings unlocks, the AI may spend up to cashSpendCapPct
//     of starting-cycle cash. A big spend that re-drops cash below
//     the floor re-locks the cap.
const SAFETY = {
  // Action limits
  maxActionsPerCycle:     5,

  // Cash policy
  minCashReserve:         1_000_000,    // hard floor
  savingsTarget:        100_000_000,    // soft target (scale with progress)
  cashSpendCapPct:       90,            // per-cycle spend ceiling

  // Augmentation gating
  minAugsToInstall:       5,
  requireConfirmForReset: true,

  // Hard deny list — never executed regardless of any other check
  blockedActions:         ["soft_reset"],

  // Logging — gates /logs/ollama-player.txt writes
  logAllActions:          true
};

const DEPRECATED_SCRIPTS = [
  "hacknetupgrades.js",
  "copyScriptsOnServers.js",
  "runScriptsOnServers.js",
  "scriptsync.js",
  "takecourses.js",
  "checkserver.js",
  "multitargethack.js",
  "FoodNstuff.js",
  "Targethack.js",
  "contracts.js"
];

const CYCLE_MS = 30_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  openTail(ns);

  if (ns.args.includes("--cleanup")) {
    await cleanupDeprecated(ns);
    return;
  }

  warnOnConflicts(ns);

  // Publish the live economy policy to /Temp/economy.json every
  // cycle so other in-game scripts (upgrader, future helpers) can
  // honour the same minCashReserve / savingsTarget without each
  // having its own hardcoded copy.
  function writeEconomy() {
    try {
      const cap     = Number(FLAGS.maxInGameRamGB) || 0;
      const usedGB  = currentManagedRam(ns);
      const homeMax = ns.getServerMaxRam("home");
      ns.write("/Temp/economy.json", JSON.stringify({
        ts: Date.now(),
        minCashReserve:    SAFETY.minCashReserve,
        savingsTarget:     SAFETY.savingsTarget,
        cashSpendCapPct:   SAFETY.cashSpendCapPct,
        savingsThreshold:  SAFETY.minCashReserve + SAFETY.savingsTarget,
        // RAM budget snapshot for AI player + other helpers.
        maxInGameRamGB:    cap,
        homeMaxRamGB:      homeMax,
        managedRamGB:      Number(usedGB.toFixed(2)),
        budgetRemainingGB: cap > 0 ? Number(Math.max(0, cap - usedGB).toFixed(2)) : null
      }, null, 2), "w");
    } catch (_) {}
  }
  writeEconomy();

  while (true) {
    writeEconomy();
    if (FLAGS.launchCompanions) launchCompanions(ns);

    if (FLAGS.autoContracts) {
      await ensureContractorExists(ns, "/contractor.js");
      ensureRunning(ns, "/contractor.js");
    } else {
      ensureStopped(ns, "/contractor.js");
    }

    if (FLAGS.watchdog) {
      const watchdogFile = "/scb-watchdog.js";
      await ensureWatchdogExists(ns, watchdogFile);
      ensureRunning(ns, watchdogFile);
    } else {
      ensureStopped(ns, "/scb-watchdog.js");
    }

    if (FLAGS.serverUpgrader) {
      const upgraderFile = "/server-upgrader.js";
      await ensureUpgraderExists(ns, upgraderFile);
      ensureRunning(ns, upgraderFile);
    } else {
      ensureStopped(ns, "/server-upgrader.js");
    }

    if (FLAGS.ollamaPlayer) {
      const ok = ensurePlayerScripts(ns);
      if (ok) {
        ensureRunning(
          ns,
          "/ollama-player.js",
          1,
          JSON.stringify(AI_CONFIG),
          JSON.stringify(SAFETY)
        );
      }
    } else {
      ensureStopped(ns, "/ollama-player.js");
    }

    const player = ns.getPlayer();
    const hackLvl = player.skills.hacking;

    if (FLAGS.buyTor || FLAGS.buyPrograms) {
      await buyToolsIfAffordable(ns);
    }

    const portCrax = getAvailablePortCrackers(ns);
    const allServers = deepScan(ns);

    ns.print("─".repeat(52));
    ns.print("INFO  Cycle @ " + new Date().toLocaleTimeString());
    ns.print("INFO  Hack Level: " + hackLvl + " | Port Crackers: " + portCrax.length + "/5");
    ns.print("INFO  Servers found: " + allServers.length);
    ns.print("─".repeat(52));

    let rooted = 0;
    let backdoored = 0;
    let skipped = 0;
    let deployed = 0;
    const backdoorQueue = [];

    // Aggregate "needs higher hack" / "needs more ports" servers into
    // single summary lines instead of one WARN per skipped host. The
    // tail used to fill with 40 identical-looking messages every cycle.
    const needHack  = [];
    const needPorts = [];

    if (FLAGS.scanAndRoot) {
      for (const hostname of allServers) {
        if (hostname === "home") continue;
        if (hostname.startsWith("hacknet")) continue;

        const server = ns.getServer(hostname);
        if (server.purchasedByPlayer) continue;

        if (server.hasAdminRights && server.backdoorInstalled) {
          if (FLAGS.deployHackScripts && deployHackScripts(ns, hostname)) deployed++;
          continue;
        }

        if (server.requiredHackingSkill > hackLvl) {
          skipped++;
          needHack.push(hostname + "(" + server.requiredHackingSkill + ")");
          continue;
        }

        if (server.numOpenPortsRequired > portCrax.length) {
          skipped++;
          needPorts.push(hostname + "(" + server.numOpenPortsRequired + ")");
          continue;
        }

        if (!server.hasAdminRights) {
          openPorts(ns, hostname, portCrax);
          ns.nuke(hostname);
          rooted++;
          ns.print("SUCCESS  Rooted: " + hostname);
        }

        const refreshed = ns.getServer(hostname);

        if (FLAGS.backdoor && !refreshed.backdoorInstalled) {
          const path = findPath(ns, "home", hostname);
          if (path.length === 0) {
            ns.print("ERROR  No path to " + hostname);
          } else {
            backdoorQueue.push({ hostname, path });
          }
        }

        if (FLAGS.deployHackScripts && ns.hasRootAccess(hostname)) {
          if (deployHackScripts(ns, hostname)) deployed++;
        }
      }
    }

    if (FLAGS.backdoor && backdoorQueue.length > 0) {
      const workerFile = "/backdoor-worker.js";
      await ensureBackdoorWorkerExists(ns, workerFile);

      for (const job of backdoorQueue) {
        const pathStr = JSON.stringify(job.path);

        if (isRunningExact(ns, workerFile, job.hostname, pathStr)) {
          ns.print("INFO  " + pad(job.hostname, 24) + " backdoor worker already running");
          continue;
        }

        const pid = ns.exec(workerFile, "home", 1, job.hostname, pathStr);

        if (pid > 0) {
          backdoored++;
          ns.print("SUCCESS  Spawned backdoor worker: " + job.hostname + " PID " + pid);
        } else {
          ns.print("ERROR  Failed to spawn worker for " + job.hostname);
        }
      }
    }

    if (needHack.length > 0) {
      ns.print("WARN  Skipped (need hack > " + hackLvl + "): " + needHack.length + " — " + needHack.slice(0, 5).join(", ") + (needHack.length > 5 ? ", +" + (needHack.length - 5) + " more" : ""));
    }
    if (needPorts.length > 0) {
      ns.print("WARN  Skipped (need more ports than " + portCrax.length + "): " + needPorts.length + " — " + needPorts.slice(0, 5).join(", ") + (needPorts.length > 5 ? ", +" + (needPorts.length - 5) + " more" : ""));
    }

    ns.print("");
    ns.print("INFO  Rooted: " + rooted + " | Backdoor: " + backdoored + " | Deployed: " + deployed + " | Skipped: " + skipped);
    ns.print("INFO  Sleeping " + CYCLE_MS / 1000 + "s until next scan");
    ns.print("");

    appendScbLog(ns, "CYCLE hack=" + hackLvl + " crackers=" + portCrax.length + "/5 servers=" + allServers.length + " rooted=" + rooted + " backdoor=" + backdoored + " deployed=" + deployed + " skipped=" + skipped);

    await ns.sleep(CYCLE_MS);
  }
}

// ─── persistent cycle log ──────────────────────────────────────────
// .txt extension (not .log) so Bitburner's terminal `download` works.
const SCB_LOG = "/logs/scb.txt";
const SCB_LOG_PREV = "/logs/scb.1.txt";
const SCB_LOG_MAX_BYTES = 256_000;

function appendScbLog(ns, line) {
  try {
    const ts = new Date().toISOString();
    const entry = ts + " " + String(line).replace(/\s+$/, "") + "\n";
    let cur = ns.fileExists(SCB_LOG, "home") ? ns.read(SCB_LOG) : "";
    if (cur.length + entry.length > SCB_LOG_MAX_BYTES) {
      ns.write(SCB_LOG_PREV, cur, "w");
      cur = "";
    }
    ns.write(SCB_LOG, cur + entry, "w");
  } catch (_) {}
}

function warnOnConflicts(ns) {
  const autopilotOn = FLAGS.companions["autopilot.js"];
  const individualManagers = [
    "gangs.js",
    "bladeburner.js",
    "stockmaster.js",
    "sleeve.js",
    "host-manager.js",
    "hacknet-upgrade-manager.js",
    "faction-manager.js"
  ];

  const individualOn = individualManagers.some((s) => FLAGS.companions[s]);

  if (autopilotOn && individualOn) {
    ns.print("─".repeat(52));
    ns.print("WARN  autopilot.js and individual managers both enabled");
    ns.print("WARN  Pick one strategy");
    ns.print("─".repeat(52));
  }
}

function launchCompanions(ns) {
  const hasStanek = stanekIsActive(ns);

  ns.print(
    hasStanek
      ? "INFO  Stanek's Gift: ACTIVE"
      : "WARN  Stanek's Gift not accepted. Stanek scripts skipped"
  );

  for (const [file, enabled] of Object.entries(FLAGS.companions)) {
    if (!enabled) continue;
    if (file === "ollama-player.js") continue;

    if (COMPANION_NEEDS_STANEK.has(file) && !hasStanek) {
      ns.print("WARN  " + file + " requires Stanek's Gift, skipped");
      continue;
    }

    if (!ns.fileExists(file, "home")) {
      ns.print("WARN  " + file + " not found, skipped");
      continue;
    }

    const args = COMPANION_ARGS[file] || [];
    ensureRunning(ns, file, 1, ...args);
  }
}

function stanekIsActive(ns) {
  try {
    const fragments = ns.stanek.activeFragments();
    return fragments.length > 0;
  } catch {
    return false;
  }
}

function deployHackScripts(ns, hostname) {
  const HACK = "hack.js";
  const GROW = "grow.js";
  const WEAK = "weaken.js";

  ensureLoopWorkersOnHome(ns);

  try {
    ns.scp([HACK, GROW, WEAK], hostname, "home");
  } catch {
    return false;
  }

  const target = pickBestTarget(ns);
  if (!target) return false;

  const free = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
  if (free < 4) return false;

  if (
    isRunningExact(ns, WEAK, target, hostname) ||
    isRunningExactOnServer(ns, hostname, WEAK, target)
  ) {
    return false;
  }

  const wRam = ns.getScriptRam(WEAK, "home") || 1.75;
  const gRam = ns.getScriptRam(GROW, "home") || 1.75;
  const hRam = ns.getScriptRam(HACK, "home") || 1.7;

  const wT = Math.max(1, Math.floor((free * 0.5) / wRam));
  const gT = Math.max(1, Math.floor((free * 0.3) / gRam));
  const hT = Math.max(1, Math.floor((free * 0.2) / hRam));

  let any = false;

  if (!isRunningExactOnServer(ns, hostname, WEAK, target) && ns.exec(WEAK, hostname, wT, target) > 0) any = true;
  if (!isRunningExactOnServer(ns, hostname, GROW, target) && ns.exec(GROW, hostname, gT, target) > 0) any = true;
  if (!isRunningExactOnServer(ns, hostname, HACK, target) && ns.exec(HACK, hostname, hT, target) > 0) any = true;

  if (any) {
    ns.print("SUCCESS  Deployed -> " + hostname + ": " + target + " W:" + wT + " G:" + gT + " H:" + hT);
  }

  return any;
}

function ensureLoopWorkersOnHome(ns) {
  const workers = [
    {
      file: "hack.js",
      body: "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.hack(t);}"
    },
    {
      file: "grow.js",
      body: "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.grow(t);}"
    },
    {
      file: "weaken.js",
      body: "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.weaken(t);}"
    }
  ];

  for (const { file, body } of workers) {
    if (!ns.fileExists(file, "home")) {
      ns.write(file, body, "w");
    }
  }
}

let bestTargetCache = { name: null, expires: 0 };

function pickBestTarget(ns) {
  if (Date.now() < bestTargetCache.expires && bestTargetCache.name) {
    return bestTargetCache.name;
  }

  const player = ns.getPlayer();
  const all = deepScan(ns);

  const candidates = all
    .filter((s) => s !== "home")
    .filter((s) => !s.startsWith("hacknet"))
    .filter((s) => !s.startsWith("pserv"))
    .filter((s) => !s.startsWith("ai-pserv"))
    .filter((s) => ns.hasRootAccess(s))
    .filter((s) => ns.getServerRequiredHackingLevel(s) <= player.skills.hacking / 2 + 1)
    .map((s) => ({
      name: s,
      score: ns.getServerMaxMoney(s) / Math.max(1, ns.getServerMinSecurityLevel(s))
    }))
    .sort((a, b) => b.score - a.score);

  const pick = candidates[0]?.name || "n00dles";
  bestTargetCache = { name: pick, expires: Date.now() + 60_000 };
  return pick;
}

async function ensureBackdoorWorkerExists(ns, filename) {
  if (ns.fileExists(filename, "home")) return;

  const code = [
    "/** @param {NS} ns */",
    "export async function main(ns) {",
    "  const hostname = ns.args[0];",
    "  const path = JSON.parse(ns.args[1]);",
    "  ns.singularity.connect('home');",
    "  for (const hop of path) ns.singularity.connect(hop);",
    "  await ns.singularity.installBackdoor();",
    "  ns.tprint('SUCCESS  Backdoored: ' + hostname);",
    "  ns.singularity.connect('home');",
    "}"
  ].join("\n");

  ns.write(filename, code, "w");
}

async function ensureUpgraderExists(ns, filename) {
  if (ns.fileExists(filename, "home")) {
    const content = ns.read(filename);
    if (content.includes("UPGRADER_VERSION_12_SAVINGS_AWARE")) return;

    ns.rm(filename, "home");
    ns.print("INFO  Regenerating server-upgrader.js");
  }

  ns.write(filename, UPGRADER_CODE, "w");
}

async function ensureContractorExists(ns, filename) {
  if (ns.fileExists(filename, "home")) {
    const content = ns.read(filename);
    if (content.includes("CONTRACTOR_VERSION_1")) return;

    ns.rm(filename, "home");
    ns.print("INFO  Regenerating contractor.js");
  }

  ns.write(filename, CONTRACTOR_CODE, "w");
}

async function ensureWatchdogExists(ns, filename) {
  if (ns.fileExists(filename, "home")) {
    const content = ns.read(filename);
    if (content.includes("WATCHDOG_VERSION_2")) return;

    ns.rm(filename, "home");
    ns.print("INFO  Regenerating scb-watchdog.js");
  }

  ns.write(filename, WATCHDOG_CODE, "w");
}

function ensurePlayerScripts(ns) {
  const need = [
    { file: "/ollama-actions.js", marker: "ACTIONS_VERSION_4" },
    { file: "/ollama-player.js",  marker: "PLAYER_VERSION_8"  }
  ];

  let ok = true;

  for (const n of need) {
    if (!ns.fileExists(n.file, "home")) {
      ns.print("ERROR  " + n.file + " missing");
      ok = false;
      continue;
    }

    const content = ns.read(n.file);

    if (!content.includes(n.marker)) {
      ns.print("WARN  " + n.file + " outdated, missing " + n.marker);
    }
  }

  return ok;
}

async function cleanupDeprecated(ns) {
  ns.tprint("INFO  scb.js cleanup mode");

  let moved = 0;
  let missing = 0;

  for (const file of DEPRECATED_SCRIPTS) {
    if (!ns.fileExists(file, "home")) {
      missing++;
      continue;
    }

    const dest = "/Deprecated/" + file;

    try {
      ns.mv("home", file, dest);
      ns.tprint("MOVED  " + file + " -> " + dest);
      moved++;
    } catch (e) {
      ns.tprint("ERROR  Could not move " + file + ": " + String(e));
    }
  }

  ns.tprint("INFO  cleanup complete, moved: " + moved + ", missing: " + missing);
}

function deepScan(ns) {
  const visited = new Set();
  const queue = ["home"];

  while (queue.length > 0) {
    const cur = queue.pop();

    if (visited.has(cur)) continue;

    visited.add(cur);

    for (const n of ns.scan(cur)) {
      if (!visited.has(n)) queue.push(n);
    }
  }

  return [...visited];
}

function findPath(ns, source, target) {
  const visited = new Set([source]);
  const queue = [[source, []]];

  while (queue.length > 0) {
    const [current, path] = queue.shift();

    for (const neighbor of ns.scan(current)) {
      if (visited.has(neighbor)) continue;

      visited.add(neighbor);

      const newPath = [...path, neighbor];

      if (neighbor === target) return newPath;

      queue.push([neighbor, newPath]);
    }
  }

  return [];
}

async function buyToolsIfAffordable(ns) {
  if (FLAGS.buyTor && !ns.hasTorRouter()) {
    if (ns.getServerMoneyAvailable("home") >= 200_000) {
      ns.singularity.purchaseTor();
      ns.print("SUCCESS  Purchased TOR Router");
    } else {
      ns.print("WARN  TOR Router needs $200K");
      return;
    }
  }

  if (!FLAGS.buyPrograms) return;

  const programs = [
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

  for (const prog of programs) {
    if (ns.fileExists(prog.name, "home")) continue;

    if (ns.getServerMoneyAvailable("home") >= prog.cost) {
      ns.singularity.purchaseProgram(prog.name);
      ns.print("SUCCESS  Purchased " + prog.name);
    } else {
      ns.print("WARN  " + pad(prog.name, 22) + " need $" + fmt(ns, prog.cost));
    }
  }
}

function getAvailablePortCrackers(ns) {
  const crackers = [];

  if (ns.fileExists("BruteSSH.exe", "home")) crackers.push("BruteSSH");
  if (ns.fileExists("FTPCrack.exe", "home")) crackers.push("FTPCrack");
  if (ns.fileExists("relaySMTP.exe", "home")) crackers.push("relaySMTP");
  if (ns.fileExists("HTTPWorm.exe", "home")) crackers.push("HTTPWorm");
  if (ns.fileExists("SQLInject.exe", "home")) crackers.push("SQLInject");

  return crackers;
}

function openPorts(ns, hostname, crackers) {
  for (const cracker of crackers) {
    switch (cracker) {
      case "BruteSSH":
        ns.brutessh(hostname);
        break;
      case "FTPCrack":
        ns.ftpcrack(hostname);
        break;
      case "relaySMTP":
        ns.relaysmtp(hostname);
        break;
      case "HTTPWorm":
        ns.httpworm(hostname);
        break;
      case "SQLInject":
        ns.sqlinject(hostname);
        break;
    }
  }
}

function pad(str, len) {
  const value = String(str);
  return value.length >= len ? value : value + " ".repeat(len - value.length);
}

function openTail(ns) {
  try {
    ns.ui?.openTail?.();
  } catch {}
}

function normalizeFile(file) {
  return String(file || "").startsWith("/") ? String(file) : "/" + String(file);
}

function sameFile(a, b) {
  return normalizeFile(a) === normalizeFile(b);
}

function isRunningByFile(ns, file) {
  return ns.ps("home").some((p) => sameFile(p.filename, file));
}

function isRunningExact(ns, file, ...args) {
  return ns.ps("home").some((p) => {
    if (!sameFile(p.filename, file)) return false;
    if (p.args.length !== args.length) return false;

    for (let i = 0; i < args.length; i++) {
      if (String(p.args[i]) !== String(args[i])) return false;
    }

    return true;
  });
}

function isRunningExactOnServer(ns, server, file, ...args) {
  return ns.ps(server).some((p) => {
    if (p.filename !== file && normalizeFile(p.filename) !== normalizeFile(file)) return false;
    if (p.args.length !== args.length) return false;

    for (let i = 0; i < args.length; i++) {
      if (String(p.args[i]) !== String(args[i])) return false;
    }

    return true;
  });
}

function ensureRunning(ns, file, threads = 1, ...args) {
  if (isRunningByFile(ns, file)) {
    ns.print("INFO  " + file + " already running");
    return false;
  }

  if (!withinRamBudget(ns, file, threads)) {
    const cost = safeScriptRam(ns, file) * threads;
    ns.print("WARN  skipping " + file + " — would exceed maxInGameRamGB=" +
      FLAGS.maxInGameRamGB + " (cost " + cost.toFixed(1) + " GB, used " +
      currentManagedRam(ns).toFixed(1) + " GB)");
    return false;
  }

  const pid = ns.exec(file, "home", threads, ...args);

  if (pid > 0) {
    ns.print("SUCCESS  Started " + file + " PID " + pid);
    return true;
  }

  ns.print("ERROR  Failed to start " + file + " RAM?");
  return false;
}

// ─── RAM budget ─────────────────────────────────────────────────────
// "Managed" RAM = everything currently running on home that we spawn,
// excluding scb.js itself. The budget cap applies to this set.
function safeScriptRam(ns, file) {
  try { return ns.getScriptRam(file, "home") || 0; }
  catch (_) { return 0; }
}

function currentManagedRam(ns) {
  const self = ns.getScriptName();
  let total = 0;
  for (const proc of ns.ps("home")) {
    if (proc.filename === self) continue;
    total += safeScriptRam(ns, proc.filename) * proc.threads;
  }
  return total;
}

function withinRamBudget(ns, file, threads) {
  const cap = Number(FLAGS.maxInGameRamGB) || 0;
  if (cap <= 0) return true; // unlimited
  const cost = safeScriptRam(ns, file) * Math.max(1, threads);
  return currentManagedRam(ns) + cost <= cap;
}

function ensureStopped(ns, file) {
  let killed = 0;

  for (const p of ns.ps("home")) {
    if (sameFile(p.filename, file)) {
      ns.kill(p.pid);
      killed++;
    }
  }

  if (killed > 0) {
    ns.print("INFO  Stopped " + file + " " + killed + " instance(s)");
  }

  return killed;
}

function killIfRunning(ns, file) {
  return ensureStopped(ns, file);
}

function fmt(ns, n) {
  if (ns.format && typeof ns.format.number === "function") {
    return ns.format.number(n);
  }

  return String(n);
}

const UPGRADER_CODE = String.raw`
/**
 * server-upgrader.js
 * UPGRADER_VERSION_12_SAVINGS_AWARE
 *
 * Fleet target scales with home RAM:
 *     target = clamp(START_RAM, cloudLimit, HOME_RAM_PCT * homeMaxRam)
 * snapped to the nearest lower power of 2.
 *
 * Each cycle the upgrader:
 *   1. Reads the savings policy from /Temp/economy.json (written by
 *      scb.js). While liquid cash < (minCashReserve + savingsTarget)
 *      ALL purchases and upgrades pause — the upgrader sleeps until
 *      cash recovers.
 *   2. Buys a fresh START_RAM pserv if a slot is open.
 *   3. Picks the smallest pserv below target and doubles its RAM
 *      (subject to the per-cycle cash-reserve guard).
 *
 * When home RAM grows the target lifts automatically — no restart.
 */

/** @param {NS} ns */
export async function main(ns) {
  const ENABLED          = true;
  const HOME_RAM_PCT     = 0.10;          // pserv cap = 10% of home max RAM
  const RESERVE_MODE     = "percent";
  const FIXED_RESERVE    = 500_000_000;
  const PERCENT_RESERVE  = 10;
  const CHECK_INTERVAL_MS = 30_000;
  const MAX_SERVERS      = ns.cloud.getServerLimit();
  const START_RAM_GB     = 8;
  const SERVER_PREFIX    = "pserv-";
  const TAIL_KEY         = "/Temp/server-upgrader-tail-open.txt";
  const ECONOMY_FILE     = "/Temp/economy.json";

  ns.disableLog("ALL");

  const self = ns.getScriptName();
  const running = ns.ps("home").filter((p) => p.filename === self);

  if (running.length > 1) {
    ns.print("WARN  Duplicate server-upgrader.js detected. Exiting.");
    return;
  }

  if (!ns.fileExists(TAIL_KEY, "home")) {
    ns.write(TAIL_KEY, "true", "w");
    try {
      ns.ui.openTail();
    } catch {}
  }

  if (!ENABLED) {
    ns.print("WARN  Server upgrader DISABLED");
    return;
  }

  while (true) {
    const owned   = ns.cloud.getServerNames();
    const money   = ns.getServerMoneyAvailable("home");
    const reserve = RESERVE_MODE === "percent"
      ? money * (PERCENT_RESERVE / 100)
      : FIXED_RESERVE;

    // Savings lock: read economy.json (scb.js writes it). While
    // cash < (minCashReserve + savingsTarget) we pause spending.
    const econ = readEconomy(ns, ECONOMY_FILE);
    const savingsThreshold = (econ.minCashReserve || 0) + (econ.savingsTarget || 0);
    const savingsLocked = savingsThreshold > 0 && money < savingsThreshold;

    const homeMax  = ns.getServerMaxRam("home");
    const cloudCap = ns.cloud.getRamLimit();
    const target   = computeTarget(homeMax, cloudCap, HOME_RAM_PCT, START_RAM_GB);

    ns.print("─".repeat(48));
    ns.print("INFO  Server Upgrader @ " + new Date().toLocaleTimeString());
    ns.print("INFO  Owned: " + owned.length + "/" + MAX_SERVERS + " | Target: " + ns.format.ram(target) + " (10% of home " + ns.format.ram(homeMax) + ")");
    ns.print("INFO  Cash: $" + ns.format.number(money) + " | Reserve: $" + ns.format.number(reserve) + " (" + RESERVE_MODE + ")");
    ns.print("INFO  Spendable: $" + ns.format.number(Math.max(0, money - reserve)));
    if (savingsLocked) {
      ns.print("INFO  SAVINGS-LOCKED: cash $" + ns.format.number(money) + " < threshold $" + ns.format.number(savingsThreshold) + ". Skipping all purchases this cycle.");
    }
    ns.print("─".repeat(48));

    if (savingsLocked) {
      await ns.sleep(CHECK_INTERVAL_MS);
      continue;
    }

    let bought = false;

    // 1) buy a new pserv at START_RAM if slots remain
    if (owned.length < MAX_SERVERS) {
      const cost = ns.cloud.getServerCost(START_RAM_GB);

      if (money - cost >= reserve) {
        const name = nextServerName(owned, SERVER_PREFIX);
        const result = ns.cloud.purchaseServer(name, START_RAM_GB);

        if (result) {
          ns.print("SUCCESS  Bought " + result + " (" + ns.format.ram(START_RAM_GB) + ")");
          bought = true;
        } else {
          ns.print("ERROR  Purchase failed");
        }
      } else {
        ns.print("WARN  New server ($" + ns.format.number(cost) + ") exceeds budget");
      }
    }

    // 2) upgrade the smallest pserv below target — pick the cheapest
    //    next-step. If we just bought a new one this cycle, skip the
    //    upgrade pass to keep cash for more new pservs.
    const refreshed = ns.cloud.getServerNames();
    const upgradeable = refreshed
      .map((srv) => ({ srv, ram: ns.getServerMaxRam(srv) }))
      .filter((s) => s.ram < target)
      .sort((a, b) => a.ram - b.ram);

    if (!bought && upgradeable.length > 0) {
      const pick    = upgradeable[0];
      const nextRam = Math.min(target, pick.ram * 2);
      const cost    = ns.cloud.getServerUpgradeCost(pick.srv, nextRam);
      const cashNow = ns.getServerMoneyAvailable("home");
      const reserveNow = RESERVE_MODE === "percent"
        ? cashNow * (PERCENT_RESERVE / 100)
        : FIXED_RESERVE;

      if (cost < 0 || cost === Infinity) {
        ns.print("WARN  " + pick.srv + " cannot compute upgrade cost");
      } else if (cashNow - cost < reserveNow) {
        // Couldn't afford the upgrade. If slots remain, falling back
        // to buying a fresh START_RAM pserv on the next cycle is more
        // useful than sitting idle — the cycle loop will handle it.
        ns.print("WARN  " + pick.srv + " (" + ns.format.ram(pick.ram) + " -> " + ns.format.ram(nextRam) + ") $" + ns.format.number(cost) + " exceeds budget");
      } else {
        ns.killall(pick.srv);
        const success = ns.cloud.upgradeServer(pick.srv, nextRam);
        if (success) {
          ns.print("SUCCESS  " + pick.srv + ": " + ns.format.ram(pick.ram) + " -> " + ns.format.ram(nextRam) + " $" + ns.format.number(cost));
        } else {
          ns.print("ERROR  Failed to upgrade " + pick.srv);
        }
      }
    }

    const finalOwned   = ns.cloud.getServerNames();
    const belowTarget  = finalOwned.filter((srv) => ns.getServerMaxRam(srv) < target).length;

    if (belowTarget === 0 && finalOwned.length >= MAX_SERVERS) {
      ns.print("INFO  All " + finalOwned.length + " servers at " + ns.format.ram(target) + "+. Sleeping (will re-check after home RAM grows).");
    } else if (belowTarget > 0) {
      ns.print("INFO  " + belowTarget + " server(s) still below " + ns.format.ram(target));
    }

    await ns.sleep(CHECK_INTERVAL_MS);
  }
}

function computeTarget(homeMax, cloudCap, pct, floorRam) {
  const raw    = Math.min(cloudCap, Math.max(floorRam, homeMax * pct));
  const exp    = Math.floor(Math.log2(Math.max(floorRam, raw)));
  const snapped = Math.pow(2, exp);
  return Math.max(floorRam, Math.min(snapped, cloudCap));
}

function readEconomy(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return {};
    return JSON.parse(ns.read(path)) || {};
  } catch (_) { return {}; }
}

function nextServerName(owned, prefix) {
  let index = 0;
  while (owned.includes(prefix + index)) index++;
  return prefix + index;
}
`;

const CONTRACTOR_CODE = String.raw`
/**
 * contractor.js
 * CONTRACTOR_VERSION_1
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  while (true) {
    const servers = deepScan(ns);
    let found = 0;

    for (const server of servers) {
      const contracts = ns.ls(server, ".cct");

      for (const contract of contracts) {
        found++;
        ns.print("INFO  Contract found: " + contract + " on " + server);
      }
    }

    if (found > 0) {
      ns.print("INFO  Contracts found this pass: " + found);
    }

    await ns.sleep(60_000);
  }
}

function deepScan(ns) {
  const visited = new Set();
  const queue = ["home"];

  while (queue.length > 0) {
    const cur = queue.pop();

    if (visited.has(cur)) continue;

    visited.add(cur);

    for (const n of ns.scan(cur)) {
      if (!visited.has(n)) queue.push(n);
    }
  }

  return [...visited];
}
`;

const WATCHDOG_CODE = String.raw`
/**
 * scb-watchdog.js
 * WATCHDOG_VERSION_2
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const HEARTBEAT = "/Temp/scb-heartbeat.txt";
  const INTERVAL = 10_000;

  while (true) {
    ns.write(HEARTBEAT, String(Date.now()), "w");
    await ns.sleep(INTERVAL);
  }
}
`;