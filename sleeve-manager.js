/**
 * sleeve-manager.js — minimal sleeve autopilot (AI-steerable)
 *
 * SLEEVE_MANAGER_VERSION_1
 *
 * Each cycle, for every unlocked sleeve, picks a task in this priority:
 *
 *   1. AI directive at /Temp/sleeve-directives.json (per-sleeve or default)
 *   2. Auto: setToShockRecovery while shock > SHOCK_THRESHOLD
 *   3. Auto: setToSynchronize while sync < SYNC_TARGET
 *   4. Default fallback: setToCommitCrime("Mug")  [or AUTO_DEFAULT_CRIME]
 *
 * The task is only applied when it differs from the sleeve's current
 * state — idempotent, no log spam.
 *
 * Reads:  /Temp/sleeve-directives.json (AI-written, optional, expires 10 min)
 * Writes: /Temp/sleeve-state.json      (per-cycle snapshot for the AI)
 *         /logs/sleeve.txt             (rotates at 256 KB)
 *
 * Directive JSON shape (set via the AI's `set_sleeve_plan` action):
 *
 *   {
 *     "ts": <epoch ms>,
 *     "default": { "task": "synchronize" },
 *     "sleeves": {
 *       "0": { "task": "commit_crime",  "crime":   "Homicide" },
 *       "1": { "task": "company_work",  "company": "ECorp" },
 *       "2": { "task": "faction_work",  "faction": "CyberSec", "type": "hacking" },
 *       "3": { "task": "gym",           "gym":     "Powerhouse Gym", "stat": "strength" },
 *       "4": { "task": "study",         "course":  "Algorithms",     "university": "Rothman University" },
 *       "5": { "task": "shock_recovery" }
 *     }
 *   }
 *
 * Supported task names:
 *   shock_recovery · synchronize · idle · commit_crime · gym · study ·
 *   company_work · faction_work
 */

const POLL_MS              = 30_000;
const SHOCK_THRESHOLD      = 50;          // recover until shock <= this
const SYNC_TARGET          = 95;          // synchronize until sync >= this
const AUTO_DEFAULT_CRIME   = "Mug";       // fallback when no directive
const DIRECTIVES_FILE      = "/Temp/sleeve-directives.json";
const STATE_FILE           = "/Temp/sleeve-state.json";
const DIRECTIVE_STALE_MS   = 10 * 60 * 1000;
const LOG_FILE             = "/logs/sleeve.txt";
const LOG_PREV             = "/logs/sleeve.1.txt";
const LOG_MAX_BYTES        = 256_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  ns.print("INFO  sleeve-manager v1 up");
  appendLog(ns, "START sleeve-manager v1");

  while (true) {
    try { await tick(ns); }
    catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

/** @param {NS} ns */
async function tick(ns) {
  let n = 0;
  try { n = ns.sleeve.getNumSleeves(); }
  catch (_) {
    ns.print("INFO  sleeve API unavailable (need Source-File 10)");
    return;
  }
  if (!n) { ns.print("INFO  no sleeves yet"); return; }

  const directives = readDirectives(ns);
  const snapshot   = { ts: Date.now(), count: n, sleeves: [] };

  for (let i = 0; i < n; i++) {
    let info;
    try { info = ns.sleeve.getInformation(i); } catch (_) { continue; }

    const explicit  = directives.sleeves && directives.sleeves[String(i)];
    let plan;
    if (explicit) {
      plan = explicit;
    } else if ((info.shock || 0) > SHOCK_THRESHOLD) {
      plan = { task: "shock_recovery", _auto: "shock=" + Math.round(info.shock) };
    } else if ((info.sync || 100) < SYNC_TARGET) {
      plan = { task: "synchronize",    _auto: "sync="  + Math.round(info.sync) };
    } else if (directives.default) {
      plan = directives.default;
    } else {
      plan = { task: "commit_crime", crime: AUTO_DEFAULT_CRIME, _auto: "default" };
    }

    const result = applyTask(ns, i, plan);
    if (result.changed) {
      ns.print("INFO  sleeve " + i + " -> " + result.label);
      appendLog(ns, "SET sleeve=" + i + " task=" + result.label +
                    (plan._auto ? " (auto: " + plan._auto + ")" : " (directive)"));
    }

    snapshot.sleeves.push({
      idx:    i,
      shock:  Math.round(info.shock || 0),
      sync:   Math.round(info.sync  || 0),
      task:   result.label,
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

  // Publish per-cycle state so the AI player (and anything else) can
  // observe what's happening without paying RAM for ns.sleeve.* calls.
  try { ns.write(STATE_FILE, JSON.stringify(snapshot, null, 2), "w"); }
  catch (_) {}

  ns.print("INFO  sleeves=" + n +
           " avgShock=" + avg(snapshot.sleeves, "shock") +
           " avgSync="  + avg(snapshot.sleeves, "sync"));
}

/** @param {NS} ns */
function applyTask(ns, idx, plan) {
  const cur   = safe(() => ns.sleeve.getTask(idx));
  const label = describePlan(plan);

  if (curMatches(cur, plan)) return { changed: false, label };

  let ok = false;
  try {
    switch (plan.task) {
      case "shock_recovery":
        ok = ns.sleeve.setToShockRecovery(idx); break;
      case "synchronize":
        ok = ns.sleeve.setToSynchronize(idx); break;
      case "idle":
        ok = ns.sleeve.setToIdle(idx); break;
      case "commit_crime":
        ok = ns.sleeve.setToCommitCrime(idx, plan.crime || "Mug"); break;
      case "gym":
        ok = ns.sleeve.setToGymWorkout(idx,
          plan.gym  || "Powerhouse Gym",
          plan.stat || "strength");
        break;
      case "study":
        ok = ns.sleeve.setToUniversityCourse(idx,
          plan.university || "Rothman University",
          plan.course     || "Algorithms");
        break;
      case "company_work":
        if (!plan.company) return { changed: false, label: "company_work missing 'company'" };
        ok = ns.sleeve.setToCompanyWork(idx, plan.company);
        break;
      case "faction_work":
        if (!plan.faction) return { changed: false, label: "faction_work missing 'faction'" };
        ok = ns.sleeve.setToFactionWork(idx, plan.faction, plan.type || "hacking");
        break;
      default:
        return { changed: false, label: "unknown:" + plan.task };
    }
  } catch (e) {
    return { changed: false, label: "threw:" + label + " (" + String(e.message || e).slice(0, 60) + ")" };
  }
  return { changed: ok, label };
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

function readDirectives(ns) {
  try {
    if (!ns.fileExists(DIRECTIVES_FILE, "home")) return {};
    const raw = JSON.parse(ns.read(DIRECTIVES_FILE)) || {};
    if (raw.ts && Date.now() - raw.ts > DIRECTIVE_STALE_MS) return {}; // expired
    return raw;
  } catch (_) { return {}; }
}

function avg(arr, key) {
  if (!arr.length) return 0;
  const sum = arr.reduce((s, o) => s + (Number(o[key]) || 0), 0);
  return Math.round(sum / arr.length);
}

function safe(fn) { try { return fn(); } catch (_) { return null; } }

function appendLog(ns, line) {
  try {
    const ts    = new Date().toISOString();
    const entry = ts + " " + String(line).replace(/\s+$/, "") + "\n";
    let cur     = ns.fileExists(LOG_FILE, "home") ? ns.read(LOG_FILE) : "";
    if (cur.length + entry.length > LOG_MAX_BYTES) {
      ns.write(LOG_PREV, cur, "w");
      cur = "";
    }
    ns.write(LOG_FILE, cur + entry, "w");
  } catch (_) {}
}
