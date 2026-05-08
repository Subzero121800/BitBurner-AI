/**
 * /ai/dispatch/gang.js — gang_recruit / gang_assign / gang_ascend
 * DISPATCH_GANG_VERSION_1
 *
 * One-shot. Static RAM ~ 16 GB (4 ns.gang.* @ 4 GB).
 * Most AI gang work goes through set_gang_plan (pure file write,
 * handled inline in the player) — this dispatcher only fires for
 * rare direct interventions.
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
    switch (a.action) {
      case "gang_recruit": {
        const names = ns.gang.getMemberNames();
        const name = "Member-" + names.length;
        res = wrap(ns.gang.recruitMember(name), "recruited " + name);
        break;
      }
      case "gang_assign":
        res = wrap(ns.gang.setMemberTask(a.member, a.task), a.member + " -> " + a.task);
        break;
      case "gang_ascend":
        res = wrap(!!ns.gang.ascendMember(a.member), "ascended " + a.member);
        break;
      default:
        res = fail("gang: unknown action " + a.action);
    }
  } catch (e) { res = fail("gang threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

function wrap(s, r) { return { success: !!s, result: String(r) }; }
function fail(r)    { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
