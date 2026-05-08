/**
 * /ai/dispatch/hacknet.js — buy_hacknet_node / upgrade_hacknet
 * DISPATCH_HACKNET_VERSION_1
 *
 * One-shot. Static RAM ~ 20 GB (5 ns.hacknet.* @ 4 GB).
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
    if (a.action === "buy_hacknet_node") {
      const idx = ns.hacknet.purchaseNode();
      res = wrap(idx >= 0, "hacknet node " + idx);
    } else if (a.action === "upgrade_hacknet") {
      res = upgrade(ns, a);
    } else {
      res = fail("hacknet: unknown action " + a.action);
    }
  } catch (e) { res = fail("hacknet threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

function upgrade(ns, a) {
  const idx = Number(a.node || 0);
  if (idx < 0 || idx >= ns.hacknet.numNodes()) return fail("invalid hacknet node: " + a.node);
  let okR;
  if (a.type === "level")     okR = ns.hacknet.upgradeLevel(idx, 1);
  else if (a.type === "ram")  okR = ns.hacknet.upgradeRam(idx, 1);
  else if (a.type === "core") okR = ns.hacknet.upgradeCore(idx, 1);
  else return fail("unknown hacknet upgrade type: " + a.type);
  return wrap(okR, "upgraded hacknet " + idx + " " + a.type);
}

function wrap(s, r) { return { success: !!s, result: String(r) }; }
function fail(r)    { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
