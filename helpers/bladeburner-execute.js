/**
 * /helpers/bladeburner-execute.js — apply Bladeburner actions
 * BLADEBURNER_EXECUTE_VERSION_1
 *
 * One-shot. Reads /Temp/bladeburner-pending.json and applies the
 * batch (join-division, skill upgrades, switchCity, startAction).
 * Pays the write half of ns.bladeburner.* only while running.
 *
 * Pending shape:
 *   {
 *     _reqId: "...",
 *     join:   true | false,
 *     skills: [ { name }, ... ],         // upgrade by 1 level each
 *     cityChange: "City Name" | null,
 *     action: { type, name } | null
 *   }
 */

const PENDING = "/Temp/bladeburner-pending.json";
const RESULT  = "/Temp/bladeburner-exec-result.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let req;
  try { req = JSON.parse(ns.read(PENDING)); }
  catch (e) {
    write(ns, { ok: false, error: "bad pending: " + String(e) });
    return;
  }

  const out = { _reqId: req._reqId || null, ok: true };

  if (req.join) {
    try { out.joined = !!ns.bladeburner.joinBladeburnerDivision(); }
    catch (e) { out.joinError = String(e.message || e); }
  }

  if (Array.isArray(req.skills)) {
    out.skillsBought = 0;
    for (const s of req.skills) {
      try { if (ns.bladeburner.upgradeSkill(s.name, 1)) out.skillsBought++; }
      catch (_) {}
    }
  }

  if (req.cityChange) {
    try { ns.bladeburner.switchCity(req.cityChange); out.changedCity = req.cityChange; }
    catch (e) { out.cityChangeError = String(e.message || e); }
  }

  if (req.action && req.action.type && req.action.name) {
    try { out.actionStarted = !!ns.bladeburner.startAction(req.action.type, req.action.name); }
    catch (e) { out.actionError = String(e.message || e); }
  }

  write(ns, out);
}

function write(ns, payload) {
  try { ns.write(RESULT, JSON.stringify({ ts: Date.now(), ...payload }), "w"); }
  catch (_) {}
}
