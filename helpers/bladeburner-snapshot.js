/**
 * /helpers/bladeburner-snapshot.js — read-only Bladeburner state probe
 * BLADEBURNER_SNAPSHOT_VERSION_1
 *
 * One-shot. Reads every state field the manager needs to decide a
 * cycle and writes /Temp/bladeburner-snap.json. Pays the read half
 * of ns.bladeburner.* (~30+ GB) only while running.
 */

const SNAP_FILE = "/Temp/bladeburner-snap.json";

const CITIES = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];

const SKILL_PRIORITIES = [
  "Blade's Intuition", "Reaper", "Cloak", "Short-Circuit",
  "Digital Observer", "Tracer", "Overclock", "Hyperdrive"
];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let inBB = false;
  try { inBB = ns.bladeburner.inBladeburner(); }
  catch (_) {
    write(ns, { inBB: false, error: "no SF-7" });
    return;
  }

  const snap = {
    inBB,
    rank:        0,
    skillPoints: 0,
    skills:      {},
    cityChaos:   {},
    operations:  [],
    contracts:   [],
    blackOps:    [],
    currentAction: null
  };

  if (!inBB) { write(ns, snap); return; }

  try { snap.rank        = ns.bladeburner.getRank() || 0; } catch (_) {}
  try { snap.skillPoints = ns.bladeburner.getSkillPoints() || 0; } catch (_) {}
  try { snap.currentAction = ns.bladeburner.getCurrentAction(); } catch (_) {}

  for (const name of SKILL_PRIORITIES) {
    let cost = null, lvl = 0;
    try { cost = ns.bladeburner.getSkillUpgradeCost(name); } catch (_) {}
    try { lvl  = ns.bladeburner.getSkillLevel(name); } catch (_) {}
    snap.skills[name] = { cost, level: lvl };
  }

  for (const c of CITIES) {
    let chaos = null;
    try { chaos = ns.bladeburner.getCityChaos(c); } catch (_) {}
    if (chaos != null) snap.cityChaos[c] = chaos;
  }

  let opNames = [];
  try { opNames = ns.bladeburner.getActionNames("Operation") || []; } catch (_) {}
  for (const n of opNames) {
    snap.operations.push({
      name: n,
      remaining: safeNum(() => ns.bladeburner.getActionCountRemaining("Operation", n)),
      chance:    safe(()    => ns.bladeburner.getActionEstimatedSuccessChance("Operation", n))
    });
  }

  let ctNames = [];
  try { ctNames = ns.bladeburner.getActionNames("Contract") || []; } catch (_) {}
  for (const n of ctNames) {
    snap.contracts.push({
      name: n,
      remaining: safeNum(() => ns.bladeburner.getActionCountRemaining("Contract", n)),
      chance:    safe(()    => ns.bladeburner.getActionEstimatedSuccessChance("Contract", n))
    });
  }

  let blackOps = [];
  try { blackOps = ns.bladeburner.getBlackOpNames() || []; } catch (_) {}
  for (const n of blackOps) {
    snap.blackOps.push({
      name: n,
      remaining:    safeNum(() => ns.bladeburner.getActionCountRemaining("Black Operation", n)),
      requiredRank: safe(()    => ns.bladeburner.getBlackOpRank(n)),
      chance:       safe(()    => ns.bladeburner.getActionEstimatedSuccessChance("Black Operation", n))
    });
  }

  write(ns, snap);
}

function safe(fn) { try { return fn(); } catch (_) { return null; } }
function safeNum(fn) { const v = safe(fn); return v == null ? 0 : v; }

function write(ns, payload) {
  try {
    ns.write(SNAP_FILE, JSON.stringify({
      ts: Date.now(),
      version: "BLADEBURNER_SNAPSHOT_VERSION_1",
      ...payload
    }, null, 2), "w");
  } catch (_) {}
}
