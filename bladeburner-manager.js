/**
 * bladeburner-manager.js — slim orchestrator (v3)
 *
 * BLADEBURNER_MANAGER_VERSION_3
 *
 * v3 splits the previous monolithic manager (~49 GB resident) into:
 *   - /helpers/bladeburner-snapshot.js  (transient ~30 GB)
 *   - /helpers/bladeburner-execute.js   (transient ~16 GB)
 *   - bladeburner-manager.js (this file, ~3 GB resident)
 *
 * Each cycle:
 *   1. Read /Temp/bladeburner-snap.json (written by the snapshot helper).
 *   2. Read /Temp/bladeburner-directives.json (AI override, optional).
 *   3. Decide:
 *      a. Join the division when player has CURRENT_* stats >= JOIN_STAT_THRESHOLD.
 *      b. Spend skill points on SKILL_PRIORITIES (capped per cycle).
 *      c. Pick the next action: chaos retirement > black op > best
 *         operation > best contract > Field Analysis fallback.
 *   4. Write /Temp/bladeburner-pending.json and exec the helper.
 *   5. Publish /Temp/bladeburner-state.json so the AI player can see
 *      rank / SP / chaos / chosen action without paying namespace RAM.
 */

const POLL_MS                  = 30_000;
const JOIN_STAT_THRESHOLD      = 100;
const CHAOS_THRESHOLD          = 50;
const MIN_SUCCESS_CHANCE       = 0.55;
const CONTRACT_SUCCESS_CHANCE  = 0.40;
const TRUSTED_LOWER_BOUND      = 0.30;
const HIGH_CONFIDENCE_UPPER    = 0.85;
const ANTI_CHAOS_OPERATION     = "Stealth Retirement Operation";
const FALLBACK_GENERAL         = "Field Analysis";

const DIRECTIVE_STALE_MS   = 10 * 60 * 1000;

const SNAP_HELPER     = "/helpers/bladeburner-snapshot.js";
const EXEC_HELPER     = "/helpers/bladeburner-execute.js";
const SNAP_FILE       = "/Temp/bladeburner-snap.json";
const PENDING_FILE    = "/Temp/bladeburner-pending.json";
const STATE_FILE      = "/Temp/bladeburner-state.json";
const DIRECTIVES_FILE = "/Temp/bladeburner-directives.json";

const LOG_FILE      = "/logs/bladeburner.txt";
const LOG_PREV      = "/logs/bladeburner.1.txt";
const LOG_MAX_BYTES = 256_000;

const SKILL_PRIORITIES = [
  "Blade's Intuition", "Reaper", "Cloak", "Short-Circuit",
  "Digital Observer", "Tracer", "Overclock", "Hyperdrive"
];

const CITIES = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("INFO  bladeburner-manager v3 (slim orchestrator) up");
  appendLog(ns, "START bladeburner-manager v3");

  if (!ns.fileExists(SNAP_FILE, "home")) {
    launchHelper(ns, SNAP_HELPER);
    await ns.sleep(1500);
  }

  while (true) {
    try {
      tick(ns);
      launchHelper(ns, SNAP_HELPER); // refresh for next cycle
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

function tick(ns) {
  const snap = readJson(ns, SNAP_FILE);
  if (!snap) { ns.print("INFO  no bladeburner snapshot yet"); return; }
  if (snap.error === "no SF-7") {
    ns.print("INFO  Bladeburner API unavailable (need Source-File 6/7)");
    return;
  }

  const directives = readDirectives(ns);
  const skillPriorities = Array.isArray(directives.skillPriorities) && directives.skillPriorities.length
    ? directives.skillPriorities
    : SKILL_PRIORITIES;
  const chaosThreshold = (typeof directives.antiChaosThreshold === "number")
    ? directives.antiChaosThreshold
    : CHAOS_THRESHOLD;

  const pending = { _reqId: String(Date.now()) };

  // 1) Join when stats allow
  if (!snap.inBB) {
    const player = ns.getPlayer();
    const s = player.skills;
    if (s.strength < JOIN_STAT_THRESHOLD || s.defense < JOIN_STAT_THRESHOLD ||
        s.dexterity < JOIN_STAT_THRESHOLD || s.agility < JOIN_STAT_THRESHOLD) {
      ns.print("INFO  not in Bladeburner — combat stats below threshold (" + JOIN_STAT_THRESHOLD + ")");
      publishState(ns, snap, null);
      return;
    }
    pending.join = true;
    appendLog(ns, "QUEUE join Bladeburner division");
  }

  // 2) Skill upgrades — buy as many as SP allows, in priority order
  const skillsToBuy = [];
  let sp = snap.skillPoints || 0;
  while (sp > 0) {
    let bought = false;
    for (const name of skillPriorities) {
      const info = snap.skills[name];
      if (!info || info.cost == null || info.cost === Infinity) continue;
      if (sp < info.cost) continue;
      if (name === "Overclock" && (info.level || 0) >= 90) continue;
      skillsToBuy.push({ name });
      sp -= info.cost;
      bought = true;
      break;
    }
    if (!bought) break;
  }
  if (skillsToBuy.length) {
    pending.skills = skillsToBuy;
    appendLog(ns, "QUEUE skills " + skillsToBuy.map((x) => x.name).join(","));
  }

  // 3) Action selection
  let choice = null;
  let cityChange = null;

  if (directives.actionOverride && directives.actionOverride.type && directives.actionOverride.name) {
    choice = { type: directives.actionOverride.type, name: directives.actionOverride.name, reason: "directive" };
  } else {
    const picked = pickAction(snap, chaosThreshold);
    choice = picked.choice;
    cityChange = picked.cityChange;
  }

  const cur = snap.currentAction;
  if (choice && cur && cur.type === choice.type && cur.name === choice.name) {
    ns.print("INFO  continuing " + choice.type + " / " + choice.name);
  } else if (choice) {
    pending.action = { type: choice.type, name: choice.name };
    if (cityChange) pending.cityChange = cityChange;
    appendLog(ns, "QUEUE " + choice.type + " / " + choice.name + " (" + (choice.reason || "") + ")");
  } else {
    ns.print("INFO  no viable action this cycle");
  }

  if (Object.keys(pending).length > 1) {
    ns.write(PENDING_FILE, JSON.stringify(pending), "w");
    launchHelper(ns, EXEC_HELPER);
  }

  publishState(ns, snap, choice);
}

function pickAction(snap, chaosThreshold) {
  for (const c of CITIES) {
    const chaos = snap.cityChaos[c];
    if (chaos != null && chaos > chaosThreshold) {
      const op = (snap.operations || []).find((o) => o.name === ANTI_CHAOS_OPERATION);
      if (op && op.remaining > 0 && passesChanceGate(op.chance, MIN_SUCCESS_CHANCE)) {
        return {
          choice: { type: "Operation", name: ANTI_CHAOS_OPERATION, reason: "chaos " + chaos.toFixed(0) + " in " + c },
          cityChange: c
        };
      }
    }
  }

  // Black ops in order
  const rank = snap.rank || 0;
  for (const bo of (snap.blackOps || [])) {
    if (!bo.remaining || bo.remaining <= 0) continue;
    if (bo.requiredRank == null || rank < bo.requiredRank) continue;
    if (passesChanceGate(bo.chance, MIN_SUCCESS_CHANCE)) {
      return { choice: { type: "Black Operation", name: bo.name, reason: "rank " + rank.toFixed(0) + " >= " + bo.requiredRank }, cityChange: null };
    }
  }

  const opPick = bestByChance(snap.operations || [], MIN_SUCCESS_CHANCE);
  if (opPick) return { choice: { type: "Operation", name: opPick, reason: "best Operation" }, cityChange: null };

  const ctPick = bestByChance(snap.contracts || [], CONTRACT_SUCCESS_CHANCE);
  if (ctPick) return { choice: { type: "Contract", name: ctPick, reason: "best Contract" }, cityChange: null };

  return { choice: { type: "General", name: FALLBACK_GENERAL, reason: "no high-chance action available" }, cityChange: null };
}

function passesChanceGate(chance, minMidpoint) {
  if (!Array.isArray(chance) || chance.length < 2) return false;
  const [low, high] = chance;
  const mid = (low + high) / 2;
  if (mid >= minMidpoint && low >= TRUSTED_LOWER_BOUND) return true;
  if (high >= HIGH_CONFIDENCE_UPPER) return true;
  return false;
}

function bestByChance(list, minMidpoint) {
  let best = null;
  let bestScore = 0;
  for (const item of list) {
    if (!item.remaining || item.remaining <= 0) continue;
    if (!passesChanceGate(item.chance, minMidpoint)) continue;
    const mid = (item.chance[0] + item.chance[1]) / 2;
    const score = mid * Math.min(item.remaining, 100);
    if (score > bestScore) { bestScore = score; best = item.name; }
  }
  return best;
}

function publishState(ns, snap, choice) {
  try {
    const cityChaosRounded = {};
    for (const [c, v] of Object.entries(snap.cityChaos || {})) cityChaosRounded[c] = Math.round(v);
    ns.write(STATE_FILE, JSON.stringify({
      ts: Date.now(),
      version:  "BLADEBURNER_MANAGER_VERSION_3",
      inBB:     !!snap.inBB,
      rank:     snap.rank || 0,
      skillPts: snap.skillPoints || 0,
      action:   choice ? { type: choice.type, name: choice.name } : null,
      cityChaos: cityChaosRounded
    }, null, 2), "w");
  } catch (_) {}
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
