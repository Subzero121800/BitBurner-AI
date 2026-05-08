/**
 * /ai/dispatch/blade.js — bb_action / bb_skill
 * DISPATCH_BLADE_VERSION_1
 *
 * One-shot. Static RAM ~ 8 GB (2 ns.bladeburner.* @ 4 GB).
 * Long-running Bladeburner orchestration lives in
 * /bladeburner-manager.js; this dispatcher is for direct AI
 * overrides routed via set_bladeburner_plan (pure file write,
 * handled inline) or one-off bb_action / bb_skill calls.
 */

const REQ = "/Temp/ai-action-req.json";
const RES = "/Temp/ai-action-res.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let a;
  try { a = JSON.parse(ns.read(REQ)); }
  catch (e) { return writeRes(ns, fail("bad request: " + String(e))); }

  let res;
  try {
    if (a.action === "bb_action") {
      const type = normalizeBb(ns, a.type || "General");
      res = wrap(ns.bladeburner.startAction(type, a.name), "BB " + type + " / " + a.name);
    } else if (a.action === "bb_skill") {
      res = wrap(ns.bladeburner.upgradeSkill(a.skill, 1), "BB skill " + a.skill);
    } else {
      res = fail("blade: unknown action " + a.action);
    }
  } catch (e) { res = fail("blade threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

function normalizeBb(ns, value) {
  try {
    const e = ns.enums?.BladeburnerActionType;
    if (!e) return value;
    const target = String(value ?? "").toLowerCase().replace(/[\s_\-]/g, "");
    for (const v of Object.values(e)) {
      if (String(v).toLowerCase().replace(/[\s_\-]/g, "") === target) return v;
    }
  } catch (_) {}
  return value;
}

function wrap(s, r) { return { success: !!s, result: String(r) }; }
function fail(r)    { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
