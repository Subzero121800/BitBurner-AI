/**
 * bladeburner-manager.js — minimal Bladeburner autopilot
 *
 * BLADEBURNER_MANAGER_VERSION_1
 *
 * What it does, in priority order each cycle:
 *   1. Joins the Bladeburner division when player has CURRENT_*
 *      stats ≥ JOIN_STAT_THRESHOLD (typically 100 each).
 *   2. Spends accumulated skill points on the SKILL_PRIORITIES
 *      list, walking down the list and buying as many levels as
 *      we can afford.
 *   3. Picks the next action by these rules:
 *        - if any city's chaos > CHAOS_THRESHOLD, run Stealth
 *          Retirement Operation in that city to reduce it.
 *        - else if a Black Op is unlocked + we meet rank, run it.
 *        - else pick the highest-rep operation with > 0 remaining
 *          and ≥ MIN_SUCCESS_CHANCE (default 0.6).
 *        - else pick the highest-rep contract with the same gates.
 *        - else fall back to "Field Analysis" (always succeeds,
 *          slowly raises stats + chaos data).
 *   4. Kicks off the chosen action via startAction.
 *
 * Reads:  player + bladeburner state via NS
 * Writes: /logs/bladeburner.txt (rotates at 256 KB)
 */

const POLL_MS              = 30_000;
const JOIN_STAT_THRESHOLD  = 100;     // str/def/dex/agi each
const CHAOS_THRESHOLD      = 50;      // can be overridden by directive
const MIN_SUCCESS_CHANCE   = 0.6;
const ANTI_CHAOS_OPERATION = "Stealth Retirement Operation";
const FALLBACK_GENERAL     = "Field Analysis";
const LOG_FILE             = "/logs/bladeburner.txt";
const LOG_PREV             = "/logs/bladeburner.1.txt";
const LOG_MAX_BYTES        = 256_000;
const DIRECTIVES_FILE      = "/Temp/bladeburner-directives.json";
const STATE_FILE           = "/Temp/bladeburner-state.json";
const DIRECTIVE_STALE_MS   = 10 * 60 * 1000;

// AI directive shape (set via `set_bladeburner_plan` action):
//   {
//     "ts": <epoch ms>,
//     "actionOverride":     { "type": "Operation", "name": "Assassination" },
//     "antiChaosThreshold": 30,
//     "skillPriorities":    ["Reaper", "Cloak", ...]   // overrides default order
//   }

const SKILL_PRIORITIES = [
  "Blade's Intuition",          // success rate on contracts/ops
  "Reaper",                     // combat success
  "Cloak",                      // stealth contracts
  "Short-Circuit",              // retirement ops
  "Digital Observer",           // success on intel-style actions
  "Tracer",                     // chance + speed
  "Overclock",                  // action speed (cap at 90)
  "Hyperdrive",                 // exp gain
];

const CITIES = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  ns.print("INFO  bladeburner-manager v1 up");
  appendLog(ns, "START bladeburner-manager v1");

  while (true) {
    try {
      await tick(ns);
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

/** @param {NS} ns */
async function tick(ns) {
  const directives = readDirectives(ns);
  const skillPriorities  = Array.isArray(directives.skillPriorities) && directives.skillPriorities.length
    ? directives.skillPriorities
    : SKILL_PRIORITIES;
  const chaosThreshold   = (typeof directives.antiChaosThreshold === "number")
    ? directives.antiChaosThreshold
    : CHAOS_THRESHOLD;

  if (!ns.bladeburner.inBladeburner()) {
    const skills = ns.getPlayer().skills;
    if (skills.strength < JOIN_STAT_THRESHOLD ||
        skills.defense  < JOIN_STAT_THRESHOLD ||
        skills.dexterity < JOIN_STAT_THRESHOLD ||
        skills.agility   < JOIN_STAT_THRESHOLD) {
      ns.print("INFO  not in Bladeburner — combat stats below threshold (" + JOIN_STAT_THRESHOLD + ")");
      return;
    }
    if (!ns.bladeburner.joinBladeburnerDivision()) {
      ns.print("INFO  joinBladeburnerDivision returned false");
      return;
    }
    appendLog(ns, "JOIN bladeburner division");
  }

  // 1) buy skill upgrades while we can afford them
  let sp = ns.bladeburner.getSkillPoints();
  let bought = 0;
  while (sp > 0) {
    let found = false;
    for (const name of skillPriorities) {
      const cost = safe(() => ns.bladeburner.getSkillUpgradeCost(name));
      if (cost == null || cost === Infinity) continue;
      if (sp < cost) continue;
      // Cap Overclock at level 90 (game cap).
      if (name === "Overclock") {
        const lvl = safe(() => ns.bladeburner.getSkillLevel(name)) || 0;
        if (lvl >= 90) continue;
      }
      if (ns.bladeburner.upgradeSkill(name)) {
        bought++;
        sp = ns.bladeburner.getSkillPoints();
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  if (bought > 0) appendLog(ns, "SKILLS bought " + bought + " level(s); SP left=" + sp);

  // 2) pick action — directive override OR auto-selection
  let choice;
  if (directives.actionOverride && directives.actionOverride.type && directives.actionOverride.name) {
    choice = {
      type: directives.actionOverride.type,
      name: directives.actionOverride.name,
      reason: "directive"
    };
  } else {
    choice = pickAction(ns, chaosThreshold);
  }
  if (!choice) {
    ns.print("INFO  no viable action this cycle");
    return;
  }

  const cur = safe(() => ns.bladeburner.getCurrentAction());
  if (cur && cur.type === choice.type && cur.name === choice.name) {
    ns.print("INFO  continuing " + choice.type + " / " + choice.name);
    return;
  }

  if (ns.bladeburner.startAction(choice.type, choice.name)) {
    appendLog(ns, "START " + choice.type + " / " + choice.name + " (" + (choice.reason || "") + ")");
    ns.print("INFO  switched to " + choice.type + " / " + choice.name);
  } else {
    appendLog(ns, "FAIL  startAction " + choice.type + " / " + choice.name);
  }

  // Publish per-cycle state for the AI player.
  try {
    ns.write(STATE_FILE, JSON.stringify({
      ts:        Date.now(),
      inBB:      true,
      rank:      safe(() => ns.bladeburner.getRank()) || 0,
      skillPts:  safe(() => ns.bladeburner.getSkillPoints()) || 0,
      action:    { type: choice.type, name: choice.name },
      cityChaos: CITIES.reduce((acc, c) => {
        const v = safe(() => ns.bladeburner.getCityChaos(c));
        if (v != null) acc[c] = Math.round(v);
        return acc;
      }, {})
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

/** @param {NS} ns */
function pickAction(ns, chaosThreshold) {
  // Anti-chaos: any city above threshold? Travel + retirement.
  for (const city of CITIES) {
    const chaos = safe(() => ns.bladeburner.getCityChaos(city));
    if (chaos != null && chaos > chaosThreshold) {
      // Travel to that city before running the op.
      try { ns.bladeburner.switchCity(city); } catch (_) {}
      const remaining = safe(() => ns.bladeburner.getActionCountRemaining("Operation", ANTI_CHAOS_OPERATION));
      const chance    = safe(() => ns.bladeburner.getActionEstimatedSuccessChance("Operation", ANTI_CHAOS_OPERATION));
      if (remaining > 0 && chance && chance[0] >= 0.5) {
        return { type: "Operation", name: ANTI_CHAOS_OPERATION, reason: "chaos " + chaos.toFixed(0) + " in " + city };
      }
    }
  }

  // Black ops — run the lowest-rank locked one we meet rank for.
  const blackOps = safe(() => ns.bladeburner.getBlackOpNames()) || [];
  const rank     = safe(() => ns.bladeburner.getRank()) || 0;
  for (const op of blackOps) {
    const rem = safe(() => ns.bladeburner.getActionCountRemaining("Black Operation", op));
    if (!rem || rem <= 0) continue; // already completed
    const required = safe(() => ns.bladeburner.getBlackOpRank(op));
    if (required == null || rank < required) continue;
    const chance = safe(() => ns.bladeburner.getActionEstimatedSuccessChance("Black Operation", op));
    if (chance && chance[0] >= MIN_SUCCESS_CHANCE) {
      return { type: "Black Operation", name: op, reason: "rank " + rank.toFixed(0) + " ≥ " + required };
    }
  }

  // Operations — best by rep gain, gated on chance + count.
  const ops = safe(() => ns.bladeburner.getActionNames("Operation")) || [];
  const opPick = bestByChance(ns, "Operation", ops);
  if (opPick) return { type: "Operation", name: opPick, reason: "best Operation" };

  // Contracts — fallback before general actions.
  const contracts = safe(() => ns.bladeburner.getActionNames("Contract")) || [];
  const ctPick = bestByChance(ns, "Contract", contracts);
  if (ctPick) return { type: "Contract", name: ctPick, reason: "best Contract" };

  // Last resort: general action that won't fail.
  return { type: "General", name: FALLBACK_GENERAL, reason: "no high-chance action available" };
}

/** @param {NS} ns */
function bestByChance(ns, type, names) {
  let best = null;
  let bestScore = 0;
  for (const name of names) {
    const remaining = safe(() => ns.bladeburner.getActionCountRemaining(type, name));
    if (!remaining || remaining <= 0) continue;
    const chance = safe(() => ns.bladeburner.getActionEstimatedSuccessChance(type, name));
    if (!chance || chance[0] < MIN_SUCCESS_CHANCE) continue;
    // Score by chance × remaining (run fully-stocked actions first).
    const score = chance[0] * Math.min(remaining, 100);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

function safe(fn) {
  try { return fn(); } catch (_) { return null; }
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
