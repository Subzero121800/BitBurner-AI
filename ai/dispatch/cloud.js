/**
 * /ai/dispatch/cloud.js — buy_server / upgrade_server
 * DISPATCH_CLOUD_VERSION_1
 *
 * One-shot. Static RAM ~ 13 GB (ns.cloud.* + killall + helpers).
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
    if (a.action === "buy_server")          res = buyServer(ns, Number(a.ram || 8));
    else if (a.action === "upgrade_server") res = upgradeServer(ns, a.server, Number(a.ram || 0));
    else                                    res = fail("cloud: unknown action " + a.action);
  } catch (e) { res = fail("cloud threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

function buyServer(ns, ram) {
  ram = sanitizeRam(ram);
  const max = ns.cloud.getServerLimit();
  const owned = ns.cloud.getServerNames();
  if (owned.length >= max) return fail("server limit reached");

  const cost = ns.cloud.getServerCost(ram);
  const cash = ns.getServerMoneyAvailable("home");
  if (cash < cost) return fail("insufficient funds for " + ns.format.ram(ram) + " server");

  const name = nextServerName(owned, "ai-pserv-");
  const bought = ns.cloud.purchaseServer(name, ram);
  return wrap(!!bought, "bought " + bought + " " + ns.format.ram(ram));
}

function upgradeServer(ns, server, ram) {
  if (!server) return fail("missing server");
  let current = 0;
  try { current = ns.getServerMaxRam(server); }
  catch { return fail("invalid server: " + server); }

  ram = sanitizeRam(ram);
  if (ram <= current) ram = current * 2;
  const cap = ns.cloud.getRamLimit();
  if (ram > cap) ram = cap;

  const cost = ns.cloud.getServerUpgradeCost(server, ram);
  if (!Number.isFinite(cost) || cost < 0) return fail("cannot compute upgrade cost");

  const cash = ns.getServerMoneyAvailable("home");
  if (cash < cost) return fail("insufficient funds for upgrade");

  ns.killall(server);
  return wrap(ns.cloud.upgradeServer(server, ram),
              "upgraded " + server + " to " + ns.format.ram(ram));
}

function sanitizeRam(value) {
  let r = Number(value || 8);
  if (!Number.isFinite(r) || r < 8) r = 8;
  r = Math.pow(2, Math.floor(Math.log2(r)));
  return Math.max(8, r);
}
function nextServerName(owned, prefix) {
  let i = 0;
  while (owned.includes(prefix + i)) i++;
  return prefix + i;
}

function wrap(s, r) { return { success: !!s, result: String(r) }; }
function fail(r)    { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
