/**
 * sleeve-manager.js — sleeve autopilot v5 (slim orchestrator)
 *
 * SLEEVE_MANAGER_VERSION_5
 *
 * v5 splits the previous monolithic manager (which sat at ~50 GB
 * resident because of the full sleeve namespace surface) into:
 *   - /helpers/sleeve-snapshot.js  (read state, transient ~16 GB)
 *   - /helpers/sleeve-execute.js   (apply tasks + augs, transient ~36 GB)
 *   - sleeve-manager.js (this file, ~3 GB resident)
 *
 * Each cycle:
 *   1. Read /Temp/sleeve-snap.json (written by the snapshot helper).
 *   2. Read /Temp/sleeve-directives.json (AI-set, optional).
 *   3. Decide a task per sleeve using the same priority ladder as v4.
 *   4. Decide one purchasable aug per sleeve based on the savings policy.
 *   5. Write /Temp/sleeve-pending.json with the batch and exec the
 *      execute helper.
 *   6. Publish /Temp/sleeve-state.json so the AI player can read
 *      sleeve status without paying the sleeve namespace itself.
 *   7. Re-spawn the snapshot helper for the next cycle.
 *
 * Auto-priority (when the AI has no directive for a sleeve):
 *   shock > SHOCK_THRESHOLD  -> shock_recovery
 *   sync  < SYNC_TARGET       -> synchronize
 *   else                       -> commit_crime (Homicide if combat
 *                                  >= HOMICIDE_STAT_THRESHOLD, else Mug)
 */

const POLL_MS                 = 30_000;
const SHOCK_THRESHOLD         = 50;
const SYNC_TARGET             = 95;
const AUTO_DEFAULT_CRIME      = "Homicide";
const AUTO_FALLBACK_CRIME     = "Mug";
const HOMICIDE_STAT_THRESHOLD = 100;
const MIN_CASH_FOR_AUGS       = 10_000_000;
const DIRECTIVE_STALE_MS      = 10 * 60 * 1000;

const SNAP_HELPER     = "/helpers/sleeve-snapshot.js";
const EXEC_HELPER     = "/helpers/sleeve-execute.js";
const SNAP_FILE       = "/Temp/sleeve-snap.json";
const PENDING_FILE    = "/Temp/sleeve-pending.json";
const STATE_FILE      = "/Temp/sleeve-state.json";
const DIRECTIVES_FILE = "/Temp/sleeve-directives.json";
const ECON_FILE       = "/Temp/economy.json";

const LOG_FILE      = "/logs/sleeve.txt";
const LOG_PREV      = "/logs/sleeve.1.txt";
const LOG_MAX_BYTES = 256_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("INFO  sleeve-manager v5 (slim orchestrator) up");
  appendLog(ns, "START sleeve-manager v5");

  // Bootstrap: kick a snapshot before the first tick if we don't have one.
  if (!ns.fileExists(SNAP_FILE, "home")) {
    launchHelper(ns, SNAP_HELPER);
    await ns.sleep(1500);
  }

  let lastCount = -1;
  let lastStatusSig = null;

  while (true) {
    try {
      const result = tick(ns, lastCount, lastStatusSig);
      if (result && typeof result.count === "number")    lastCount = result.count;
      if (result && typeof result.statusSig === "string") lastStatusSig = result.statusSig;
      // Re-spawn snap for next cycle.
      launchHelper(ns, SNAP_HELPER);
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

function tick(ns, lastCount, lastStatusSig) {
  const snap = readJson(ns, SNAP_FILE);
  if (!snap || typeof snap.count !== "number") {
    ns.print("INFO  no sleeve snapshot yet — wait one cycle");
    return null;
  }
  if (snap.error === "no SF-10") {
    ns.print("INFO  sleeve API unavailable (need Source-File 10)");
    return { count: 0, statusSig: "" };
  }
  const n = snap.count;
  if (!n) { ns.print("INFO  no sleeves yet"); return { count: 0, statusSig: "" }; }

  if (typeof lastCount === "number" && lastCount >= 0 && n > lastCount) {
    const gained = n - lastCount;
    ns.print("SUCCESS  detected " + gained + " new sleeve(s) (now " + n + ")");
    appendLog(ns, "UNLOCK +" + gained + " sleeve(s) (now " + n + ")");
  }

  const directives = readDirectives(ns);
  const tasks = [];
  const stateOut = {
    ts: Date.now(),
    version: "SLEEVE_MANAGER_VERSION_5",
    count: n,
    sleeves: []
  };

  for (const s of (snap.sleeves || [])) {
    const info = s.info || {};
    const cur  = s.task || null;

    const explicit = directives.sleeves && directives.sleeves[String(s.idx)];
    let plan;
    if (explicit) {
      plan = explicit;
    } else if ((info.shock || 0) > SHOCK_THRESHOLD) {
      plan = { task: "shock_recovery", _auto: "shock=" + Math.round(info.shock) };
    } else if ((info.sync || 100) < SYNC_TARGET) {
      plan = { task: "synchronize", _auto: "sync=" + Math.round(info.sync) };
    } else if (directives.default) {
      plan = directives.default;
    } else {
      const k = info.skills || {};
      const minCombat = Math.min(k.strength || 0, k.defense || 0, k.dexterity || 0, k.agility || 0);
      const crime = minCombat >= HOMICIDE_STAT_THRESHOLD ? AUTO_DEFAULT_CRIME : AUTO_FALLBACK_CRIME;
      plan = { task: "commit_crime", crime, _auto: "default(" + crime + ")" };
    }

    if (!curMatches(cur, plan)) {
      tasks.push({ idx: s.idx, ...plan });
      appendLog(ns, "QUEUE sleeve=" + s.idx + " -> " + describePlan(plan) +
                    (plan._auto ? " (auto: " + plan._auto + ")" : " (directive)"));
    }

    stateOut.sleeves.push({
      idx:    s.idx,
      shock:  Math.round(info.shock || 0),
      sync:   Math.round(info.sync || 0),
      task:   describePlan(plan),
      hp:     info.hp,
      city:   info.city,
      stats:  {
        hack: info.skills?.hacking,
        str:  info.skills?.strength,
        def:  info.skills?.defense,
        dex:  info.skills?.dexterity,
        agi:  info.skills?.agility,
        cha:  info.skills?.charisma
      }
    });
  }

  const augActions = decideAugs(ns, snap, directives);
  stateOut.augsAffordable = augActions.length;

  if (tasks.length || augActions.length) {
    ns.write(PENDING_FILE, JSON.stringify({
      _reqId: String(Date.now()),
      tasks, augs: augActions
    }), "w");
    launchHelper(ns, EXEC_HELPER);
  }

  const statusSig = stateOut.sleeves
    .map((s) => "s" + s.idx + "=" + s.task + "(sh" + s.shock + "/sy" + s.sync + ")")
    .join(" ");
  if (statusSig && statusSig !== lastStatusSig) {
    appendLog(ns, "STATUS " + statusSig);
  }
  stateOut.statusSig = statusSig;

  try { ns.write(STATE_FILE, JSON.stringify(stateOut, null, 2), "w"); } catch (_) {}

  ns.print("INFO  sleeves=" + n +
           " avgShock=" + avg(stateOut.sleeves, "shock") +
           " avgSync="  + avg(stateOut.sleeves, "sync") +
           (augActions.length ? " queueAugs=" + augActions.length : "") +
           (tasks.length ? " queueTasks=" + tasks.length : ""));

  return stateOut;
}

function decideAugs(ns, snap, directives) {
  if (directives.allowAugs === false) return [];
  const econ = readJson(ns, ECON_FILE) || {};
  const savingsFloor = econ.savingsThreshold || econ.minCashReserve || 0;
  const cashFloor = Number(directives.minCashForAugs) || MIN_CASH_FOR_AUGS;
  let cash = ns.getServerMoneyAvailable("home");
  if (cash < cashFloor) return [];

  const out = [];
  for (const s of (snap.sleeves || [])) {
    const augs = (s.augs || []).slice().sort((a, b) => a.cost - b.cost);
    for (const aug of augs) {
      if (cash < cashFloor) break;
      if (cash - aug.cost < savingsFloor) continue;
      out.push({ idx: s.idx, name: aug.name });
      cash -= aug.cost; // optimistic — execute may fail; we resync next snap
      break; // one aug per sleeve per cycle
    }
  }
  return out;
}

function curMatches(cur, plan) {
  if (!cur) return false;
  const t = String(cur.type || "").toUpperCase();
  switch (plan.task) {
    case "shock_recovery": return t === "RECOVERY";
    case "synchronize":    return t === "SYNCHRO";
    case "idle":           return t === "IDLE";
    case "commit_crime":   return t === "CRIME"   && (cur.crimeType === plan.crime || !plan.crime);
    case "gym":            return t === "CLASS"   && String(cur.classType || "").toLowerCase().includes("gym");
    case "study":          return t === "CLASS"   && !String(cur.classType || "").toLowerCase().includes("gym");
    case "company_work":   return t === "COMPANY" && cur.companyName === plan.company;
    case "faction_work":   return t === "FACTION" && cur.factionName === plan.faction;
  }
  return false;
}

function describePlan(plan) {
  if (!plan) return "(none)";
  switch (plan.task) {
    case "commit_crime": return "crime:" + (plan.crime || "Mug");
    case "company_work": return "company:" + (plan.company || "?");
    case "faction_work": return "faction:" + (plan.faction || "?") + "/" + (plan.type || "hacking");
    case "gym":          return "gym:" + (plan.stat || "strength");
    case "study":        return "study:" + (plan.course || "Algorithms");
    default:             return plan.task;
  }
}

function readDirectives(ns) {
  try {
    if (!ns.fileExists(DIRECTIVES_FILE, "home")) return {};
    const raw = JSON.parse(ns.read(DIRECTIVES_FILE)) || {};
    if (raw.ts && Date.now() - raw.ts > DIRECTIVE_STALE_MS) return {};
    return raw;
  } catch (_) { return {}; }
}

function readJson(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return null;
    return JSON.parse(ns.read(path)) || null;
  } catch (_) { return null; }
}

function launchHelper(ns, file) {
  if (!ns.fileExists(file, "home")) return;
  try { ns.exec(file, "home", 1); } catch (_) {}
}


function avg(arr, key) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, o) => s + (Number(o[key]) || 0), 0) / arr.length);
}

function appendLog(ns, line) {
  try {
    const ts = new Date().toISOString();
    const entry = ts + " " + String(line).replace(/\s+$/, "") + "\n";
    let cur = ns.fileExists(LOG_FILE, "home") ? ns.read(LOG_FILE) : "";
    if (cur.length + entry.length > LOG_MAX_BYTES) {
      ns.write(LOG_PREV, cur, "w");
      cur = "";
    }
    ns.write(LOG_FILE, cur + entry, "w");
  } catch (_) {}
}
