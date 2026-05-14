/**
 * scb.js — Master Orchestrator
 * Bitburner 3.0.0 compatible
 * SCB_VERSION_14_YIELD
 *
 * v13 also slims scb.js itself by spawning helpers under /helpers/:
 *   - /helpers/shop.js          (TOR + program purchases)
 *   - /helpers/stanek-check.js  (Stanek active-fragment probe)
 *   - /helpers/pserv-deploy.js  (purchased-server hack/share fallback)
 * The orchestrator no longer references singularity, stanek, or cloud
 * directly, so its resident RAM drops from ~19 GB to ~8 GB. Helpers
 * pay their namespace cost only while running (a few hundred ms).
 *
 * v12 introduced the /ai/snap/ + /ai/dispatch/ helper architecture
 * for the AI player; see README -> "RAM cost & limiting in-game
 * memory" for the full picture.
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
  // Suggested values (measured in-game; see README → "RAM cost &
  // limiting in-game memory"):
  //   0     unlimited (current behaviour)
  //   24    orchestrator + watchdog only (~20.65 GB)
  //   48    add the v9 AI player (~27 GB; transient helpers fit in headroom)
  //   96    add one heavy companion — gang OR bladeburner (~59 GB)
  //   128   add gang + bladeburner + sleeve managers (~115 GB; full stack)
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
    "gang-manager.js":            false,   // gang autopilot — needs SF-2
    "bladeburner-manager.js":     false,   // bladeburner autopilot — needs SF-6
    "sleeve-manager.js":          true,
    "darknet-manager.js":         true,

    // Individual managers (user-supplied; skipped silently if missing)
    "stats.js":                   true,
    "gang.js":                    true,
    "bladeburner.js":             true,
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
  // qwen3-coder:30b is the sweet spot for a Jetson Thor / 24+ GB
  // VRAM box: code-tuned, excellent structured-JSON output, reads
  // /ollama-player.js + /ollama-actions.js coherently for
  // propose_patch. ~18 GB on disk at Q4_K_M. Smaller fallbacks for
  // weaker LAN boxes: deepseek-coder-v2:16b (~9 GB) or
  // qwen2.5-coder:7b (~5 GB). Skip the deepseek-r1 family — its
  // <think> tags break parseActions.
  ollamaModel:  "qwen3-coder:30b",
  claudeHost:   "http://localhost:3000",
  claudeModel:  "sonnet",
  // 5-minute poll — the AI is the strategic layer; tactical work
  // (root, backdoor, deploy) runs every 30 s in scb.js anyway.
  // savings + jam-suppression keep it from doing anything dumb
  // between cycles. Drop to 60-120 s if you want faster reactions.
  pollInterval: 300_000,
  // 30B-class inferences run ~20-60 s on a Jetson Thor. 30 s
  // would constantly abort.
  timeoutMs:     90_000,

  // ── Model tuning ─────────────────────────────────────────────────
  // Sampling temp: 0.0 = deterministic, 0.7 = creative. Low is
  // generally better for actuator-style agents.
  temperature:  0.2,
  // Ollama context window. Bumped from 8192 to 16384 for v9 — the
  // game state + rules + recentActions runs ~4-6 K tokens and the
  // Thor has VRAM headroom for the bigger window. Drop back to
  // 8192 on smaller LAN boxes.
  numCtx:       16384,

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
        // Refresh the JSON snapshots before the player ticks. Each
        // helper runs once and exits in <1 s, so the per-namespace RAM
        // cost only materialises during execution.
        launchSnapshots(ns);
        // Auto-bounce on version mismatch — same mechanism the companion
        // managers use. Player publishes /Temp/ollama-player-state.json
        // each cycle with its source version marker; if the disk file's
        // marker has moved past the running snapshot, kill so the next
        // ensureRunning re-spawns the new code.
        ensureCompanionFresh(ns, "/ollama-player.js");
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
      // v13: spawned helper instead of inline calls so scb.js doesn't
      // hold singularity RAM resident. Helper reads /Temp/economy.json
      // for the cash floor, buys what's affordable, exits.
      const shop = "/helpers/shop.js";
      if (ns.fileExists(shop, "home") && !isRunningByFile(ns, shop)) {
        if (withinRamBudget(ns, shop, 1)) {
          try { ns.exec(shop, "home", 1); } catch (_) {}
        }
      }
    }

    await ns.sleep(0); // yield before heavy sync work

    const portCrax = getAvailablePortCrackers(ns);
    const { servers: allServers, cache: scanCache } = deepScan(ns);

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
      let _batchCount = 0;
      for (const hostname of allServers) {
        if (++_batchCount % 20 === 0) await ns.sleep(0); // yield every 20 servers
        if (hostname === "home") continue;
        if (hostname.startsWith("hacknet")) continue;

        const server = ns.getServer(hostname);
        if (server.purchasedByPlayer) continue;

        if (server.hasAdminRights && server.backdoorInstalled) {
          if (FLAGS.deployHackScripts && deployHackScripts(ns, hostname, allServers)) deployed++;
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
          const path = findPath(scanCache, "home", hostname);
          if (path.length === 0) {
            ns.print("ERROR  No path to " + hostname);
          } else {
            backdoorQueue.push({ hostname, path });
          }
        }

        if (FLAGS.deployHackScripts && ns.hasRootAccess(hostname)) {
          if (deployHackScripts(ns, hostname, allServers)) deployed++;
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

    await ns.sleep(0); // yield after server loop

    // ─── Pserv deploy pass ────────────────────────────────────────
    // v13: spawned helper instead of inline so scb.js doesn't hold
    // the cloud namespace RAM resident. Helper reads
    // /Temp/network-state.json for the target ranking and writes
    // /Temp/pserv-deploy-last.json with deploy/share counts.
    if (FLAGS.deployHackScripts) {
      const pserv = "/helpers/pserv-deploy.js";
      if (ns.fileExists(pserv, "home") && !isRunningByFile(ns, pserv)) {
        if (withinRamBudget(ns, pserv, 1)) {
          try { ns.exec(pserv, "home", 1); } catch (_) {}
        }
      }
    }
    const pservLast = readJson(ns, "/Temp/pserv-deploy-last.json") || {};
    const pservDeployed = pservLast.deployed || 0;
    const pservShared   = pservLast.shared   || 0;
    if (pservDeployed) ns.print("INFO  Pserv deploys: " + pservDeployed);
    if (pservShared)   ns.print("INFO  Pserv share workers: " + pservShared + " (no hackable target → faction-rep boost)");

    ns.print("");
    ns.print("INFO  Rooted: " + rooted + " | Backdoor: " + backdoored + " | Deployed: " + deployed + "+" + pservDeployed + " | Shared: " + pservShared + " | Skipped: " + skipped);
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
  // v13: keep /Temp/stanek-state.json fresh by spawning a one-shot
  // helper. We don't block on it — the snapshot from the previous
  // cycle is good enough; stanek state changes rarely.
  const stanekHelper = "/helpers/stanek-check.js";
  if (ns.fileExists(stanekHelper, "home") && !isRunningByFile(ns, stanekHelper)) {
    if (withinRamBudget(ns, stanekHelper, 1)) {
      try { ns.exec(stanekHelper, "home", 1); } catch (_) {}
    }
  }
  const stanekSnap = readJson(ns, "/Temp/stanek-state.json") || {};
  const hasStanek = !!stanekSnap.active;

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

    // Auto-bounce stale versions: if the disk file has a newer
    // *_VERSION_* marker than what the running instance published
    // to /Temp/<name>-state.json, kill the running instance so
    // ensureRunning will re-spawn the new version.
    ensureCompanionFresh(ns, file);

    const args = COMPANION_ARGS[file] || [];
    ensureRunning(ns, file, 1, ...args);
  }
}

// Compare the marker in the on-disk file with the `version` field
// the running manager last wrote to its /Temp/<name>-state.json
// snapshot. Kill the running instance on mismatch — ensureRunning
// will then start the new version on the same launchCompanions pass.
// No-op if the file has no recognisable marker, or no state has
// been published yet (manager hasn't ticked once).
function ensureCompanionFresh(ns, file) {
  const baseName = file.replace(/^\//, "").replace(/\.js$/, "");
  const stateFile = "/Temp/" + baseName + "-state.json";

  let diskMarker = null;
  try {
    const content = ns.read(file);
    const m = content.match(/[A-Z][A-Z_]*VERSION_\d+/);
    if (m) diskMarker = m[0];
  } catch (_) {}
  if (!diskMarker) return;

  let runningMarker = null;
  try {
    if (ns.fileExists(stateFile, "home")) {
      const st = JSON.parse(ns.read(stateFile)) || {};
      if (st.version) runningMarker = st.version;
    }
  } catch (_) {}

  if (!runningMarker) return;             // no record yet — leave alone
  if (runningMarker === diskMarker) return; // up-to-date

  // Stale — kill so ensureRunning will respawn the new version.
  let killed = 0;
  for (const p of ns.ps("home")) {
    if (p.filename === file || p.filename === "/" + file) {
      if (ns.kill(p.pid)) killed++;
    }
  }
  if (killed) {
    ns.print("INFO  bounced " + file + " (" + runningMarker + " → " + diskMarker + ")");
    appendScbLog(ns, "BOUNCE " + file + " " + runningMarker + " -> " + diskMarker);
  }
}

function readJson(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return null;
    return JSON.parse(ns.read(path)) || null;
  } catch (_) { return null; }
}

function deployHackScripts(ns, hostname, allServers) {
  const HACK = "hack.js";
  const GROW = "grow.js";
  const WEAK = "weaken.js";

  ensureLoopWorkersOnHome(ns);

  try {
    ns.scp([HACK, GROW, WEAK], hostname, "home");
  } catch {
    return false;
  }

  const target = pickBestTarget(ns, allServers);
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

function pickBestTarget(ns, knownServers) {
  if (Date.now() < bestTargetCache.expires && bestTargetCache.name) {
    return bestTargetCache.name;
  }

  const player = ns.getPlayer();
  const all = knownServers || deepScan(ns).servers;

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
  // Standalone /backdoor-worker.js as of v13 — was an inline template
  // string that inflated scb.js's RAM via the singularity connect /
  // installBackdoor mentions. If it's missing, sync it from the repo.
  if (ns.fileExists(filename, "home")) return;
  ns.print("ERROR  " + filename + " missing — sync it from the repo (it's a normal .js file now)");
}

async function ensureUpgraderExists(ns, filename) {
  // Standalone /server-upgrader.js as of v13 — was UPGRADER_CODE, a
  // string template heavy with cloud namespace mentions. The disk file
  // carries the same UPGRADER_VERSION_12 marker; we just verify it's
  // present and current.
  if (!ns.fileExists(filename, "home")) {
    ns.print("ERROR  " + filename + " missing — sync it from the repo (it's a normal .js file now)");
    return;
  }
  const content = ns.read(filename);
  if (!content.includes("UPGRADER_VERSION_12_SAVINGS_AWARE")) {
    ns.print("WARN  " + filename + " on disk does not carry UPGRADER_VERSION_12 marker — sync the repo file");
  }
}

async function ensureContractorExists(ns, filename) {
  // Standalone /contractor.js as of v13 — was a CONTRACTOR_CODE
  // template embedded in scb.js that auto-regenerated. The disk file
  // ships its own version marker; we just verify it's present.
  if (!ns.fileExists(filename, "home")) {
    ns.print("ERROR  " + filename + " missing — sync it from the repo");
  }
}

async function ensureWatchdogExists(ns, filename) {
  // Standalone /scb-watchdog.js as of v13. If missing, we don't try
  // to regen — let the user sync it from the repo. (Older scb.js
  // versions clobbered a newer watchdog with an embedded v2 stub.)
  if (!ns.fileExists(filename, "home")) {
    ns.print("ERROR  " + filename + " missing — sync it from the repo");
  }
}

function ensurePlayerScripts(ns) {
  const need = [
    { file: "/ollama-actions.js", marker: "ACTIONS_VERSION_6"  },
    { file: "/ollama-player.js",  marker: "PLAYER_VERSION_10" }
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

  // The slim player (v9) reads JSON snapshots from /Temp/ instead
  // of holding the singularity / cloud namespaces itself. Warn if
  // any snap helper is missing — the player will still run but
  // state fields will be empty until they're synced from disk.
  const snaps = ["/ai/snap/network.js", "/ai/snap/cloud.js", "/ai/snap/progression.js"];
  for (const s of snaps) {
    if (!ns.fileExists(s, "home")) ns.print("WARN  " + s + " missing — player state will be partial");
  }

  return ok;
}

// Launch the /ai/snap/*.js helpers if they aren't already running.
// Each is a one-shot: reads game state, writes /Temp/<name>-state.json,
// exits. We re-launch every scb cycle so the snapshots stay fresh
// (~30 s) without keeping their per-namespace RAM cost resident.
//
// The player also self-bootstraps fresh snapshots on its own cycle
// (see /ollama-player.js ensureSnapshotsFresh) so this is belt +
// suspenders — either layer can keep them current.
function launchSnapshots(ns) {
  const helpers = [
    "/ai/snap/network.js",
    "/ai/snap/cloud.js",
    "/ai/snap/progression.js"
  ];
  for (const file of helpers) {
    if (!ns.fileExists(file, "home")) continue;
    if (isRunningByFile(ns, file))    continue;          // still running from prior cycle
    if (!withinRamBudget(ns, file, 1)) continue;         // budget cap respected
    try { ns.exec(file, "home", 1); } catch (_) {}
  }
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

// Returns { servers: string[], cache: Map<string, string[]> }.
// Building the cache here means findPath never calls ns.scan again —
// each server is scanned exactly once per cycle regardless of how
// many backdoor paths need computing.
function deepScan(ns) {
  const visited = new Set();
  const cache   = new Map();
  const queue   = ["home"];

  while (queue.length > 0) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const neighbors = ns.scan(cur);
    cache.set(cur, neighbors);
    for (const n of neighbors) {
      if (!visited.has(n)) queue.push(n);
    }
  }

  return { servers: [...visited], cache };
}

// Uses the scan cache built by deepScan — zero additional ns.scan calls.
function findPath(cache, source, target) {
  const visited = new Set([source]);
  const queue = [[source, []]];

  while (queue.length > 0) {
    const [current, path] = queue.shift();

    for (const neighbor of (cache.get(current) || [])) {
      if (visited.has(neighbor)) continue;

      visited.add(neighbor);

      const newPath = [...path, neighbor];

      if (neighbor === target) return newPath;

      queue.push([neighbor, newPath]);
    }
  }

  return [];
}

// buyToolsIfAffordable was inline through v12; v13 replaces it with a
// spawn of /helpers/shop.js so scb.js no longer holds the singularity
// namespace resident.

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

