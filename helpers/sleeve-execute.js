/**
 * /helpers/sleeve-execute.js — applies a batch of sleeve task / aug actions
 * SLEEVE_EXECUTE_VERSION_1
 *
 * One-shot. Reads /Temp/sleeve-pending.json (written by the slim
 * sleeve-manager.js orchestrator), applies every task assignment and
 * augmentation purchase, writes /Temp/sleeve-exec-result.json with
 * counts. Pays the write half of ns.sleeve.* (~36 GB) only while
 * running, then exits.
 *
 * Pending shape:
 *   {
 *     _reqId: "...",
 *     tasks: [ { idx, task, crime?, gym?, stat?, university?, course?,
 *                company?, faction?, type? }, ... ],
 *     augs:  [ { idx, name }, ... ]
 *   }
 */

const PENDING = "/Temp/sleeve-pending.json";
const RESULT  = "/Temp/sleeve-exec-result.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let req;
  try { req = JSON.parse(ns.read(PENDING)); }
  catch (e) {
    write(ns, { ok: false, error: "bad pending: " + String(e) });
    return;
  }

  let applied = 0;
  let bought  = 0;
  const errors = [];

  for (const t of (req.tasks || [])) {
    try {
      if (applyTask(ns, t)) applied++;
    } catch (e) { errors.push("task " + t.idx + ": " + String(e.message || e)); }
  }

  for (const a of (req.augs || [])) {
    try {
      if (ns.sleeve.purchaseSleeveAug(a.idx, a.name)) bought++;
    } catch (e) { errors.push("aug " + a.idx + " " + a.name + ": " + String(e.message || e)); }
  }

  write(ns, {
    _reqId: req._reqId || null,
    ok: true,
    applied,
    bought,
    errors: errors.slice(0, 20)
  });
}

function applyTask(ns, t) {
  const idx = Number(t.idx);
  switch (t.task) {
    case "shock_recovery": return ns.sleeve.setToShockRecovery(idx);
    case "synchronize":    return ns.sleeve.setToSynchronize(idx);
    case "idle":           return ns.sleeve.setToIdle(idx);
    case "commit_crime":   return ns.sleeve.setToCommitCrime(idx, t.crime || "Mug");
    case "gym":            return ns.sleeve.setToGymWorkout(idx, t.gym || "Powerhouse Gym", t.stat || "strength");
    case "study":          return ns.sleeve.setToUniversityCourse(idx, t.university || "Rothman University", t.course || "Algorithms");
    case "company_work":   return t.company ? ns.sleeve.setToCompanyWork(idx, t.company) : false;
    case "faction_work":   return t.faction ? ns.sleeve.setToFactionWork(idx, t.faction, t.type || "hacking") : false;
    case "bladeburner":    return (t.type && t.name) ? ns.sleeve.setToBladeburnerAction(idx, t.type, t.name) : false;
    case "travel":         return t.city ? ns.sleeve.travel(idx, t.city) : false;
    case "buy_aug":        return t.aug ? ns.sleeve.purchaseSleeveAug(idx, t.aug) : false;
    default: return false;
  }
}

function write(ns, payload) {
  try {
    ns.write(RESULT, JSON.stringify({ ts: Date.now(), ...payload }), "w");
  } catch (_) {}
}
