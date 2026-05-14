/**
 * /ai/dispatch/darknet.js — direct ns.dnet.* actions for the AI player
 * DISPATCH_DARKNET_VERSION_2
 *
 * One-shot. Routes the AI's darknet_* actions through one process so
 * the player itself never imports ns.dnet (keeps the player slim).
 * Long-running session ownership lives in darknet-manager.js — this
 * dispatcher reads /Temp/darknet-sessions.json and connectToSession
 * when an op targets a manager-held session.
 *
 * Supported actions (see /ollama-actions.js ACTION_SCHEMA):
 *   darknet_probe         args: []
 *   darknet_authenticate  args: ["host", "password?"]
 *   darknet_heartbleed    args: ["host", "threads?", "peek?"]
 *   darknet_phishing      args: ["threads?"]
 *   darknet_memreal       args: ["host"]
 *   darknet_migrate       args: ["host", "threads?"]
 *   darknet_stasis_set    args: ["host"]
 *   darknet_open_cache    args: ["filename"]
 *   darknet_pumpdump      args: ["symbol", "threads?"]
 */

const REQ      = "/Temp/ai-action-req.json";
const RES      = "/Temp/ai-action-res.json";
const SESSIONS = "/Temp/darknet-sessions.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  let a;
  try { a = JSON.parse(ns.read(REQ)); }
  catch (e) { return writeRes(ns, fail("bad request: " + String(e))); }

  if (!ns.dnet) return writeRes(ns, fail("ns.dnet unavailable"), a?._reqId);

  let res;
  try { res = await exec(ns, a); }
  catch (e) { res = fail("darknet threw: " + String(e.message || e)); }
  writeRes(ns, res, a?._reqId);
}

async function exec(ns, a) {
  const sessions = readSessions(ns);

  // Reconnect under a manager-held session before host-bound ops.
  if (a.host && sessions[a.host]) {
    try { ns.dnet.connectToSession(a.host, sessions[a.host]); } catch (_) {}
  }

  switch (a.action) {
    case "darknet_probe": {
      let list = [];
      try { list = ns.dnet.probe(false) || []; }
      catch (e) { return fail("probe: " + String(e.message || e)); }
      return ok("probe: " + list.length + " neighbours — " + list.slice(0, 8).join(", "));
    }
    case "darknet_authenticate": {
      if (!a.host) return fail("darknet_authenticate needs {host}");
      const details = (() => { try { return ns.dnet.getServerAuthDetails(a.host); } catch (_) { return {}; } })();
      if (details.isOnline === false)                    return fail("authenticate " + a.host + ": offline");
      if (details.isConnectedToCurrentServer === false)  return fail("authenticate " + a.host + ": not connected");
      if (details.hasSession)                            return ok("authenticate " + a.host + ": already has session");
      const pw = a.password ?? "";
      const r = await ns.dnet.authenticate(a.host, pw, 0);
      const success = !!(r?.success ?? r);
      return { success, result: "authenticate " + a.host + " -> " + (success ? "ok" : "failed") };
    }
    case "darknet_heartbleed": {
      if (!a.host) return fail("darknet_heartbleed needs {host}");
      const t = Math.max(1, Number(a.threads) || 1);
      const opts = { threads: t };
      if (a.peek) opts.peek = true;
      const r = await ns.dnet.heartbleed(a.host, opts);
      const logs = r?.logs ?? JSON.stringify(r);
      return ok("heartbleed " + a.host + " threads=" + t + (a.peek ? " peek" : "") + " logs: " + String(logs).slice(0, 300));
    }
    case "darknet_phishing": {
      const t = Math.max(1, Number(a.threads) || 1);
      const r = await ns.dnet.phishingAttack({ threads: t });
      return ok("phishing threads=" + t + " -> " + JSON.stringify(r).slice(0, 200));
    }
    case "darknet_memreal": {
      if (!a.host) return fail("darknet_memreal needs {host}");
      const r = await ns.dnet.memoryReallocation(a.host);
      return wrap(r, "memreal " + a.host);
    }
    case "darknet_migrate": {
      if (!a.host) return fail("darknet_migrate needs {host}");
      const t = Math.max(1, Number(a.threads) || 1);
      const r = await ns.dnet.induceServerMigration(a.host, { threads: t });
      return wrap(r, "migrate " + a.host + " threads=" + t);
    }
    case "darknet_stasis_set": {
      if (!a.host) return fail("darknet_stasis_set needs {host}");
      return wrap(ns.dnet.setStasisLink(a.host), "stasis " + a.host);
    }
    case "darknet_open_cache": {
      if (!a.filename) return fail("darknet_open_cache needs {filename}");
      return wrap(ns.dnet.openCache(a.filename, !!a.suppressToast), "open_cache " + a.filename);
    }
    case "darknet_pumpdump": {
      if (!a.symbol) return fail("darknet_pumpdump needs {symbol}");
      const t = Math.max(1, Number(a.threads) || 1);
      const fn = ns.dnet.promoteStock || ns.dnet.pumpDump;
      if (!fn) return fail("ns.dnet.promoteStock unavailable");
      const r = await fn.call(ns.dnet, a.symbol, { threads: t });
      return wrap(r, "pumpdump " + a.symbol + " threads=" + t);
    }
    default:
      return fail("darknet: unknown action " + a.action);
  }
}

function readSessions(ns) {
  try {
    if (!ns.fileExists(SESSIONS, "home")) return {};
    const j = JSON.parse(ns.read(SESSIONS)) || {};
    return j.sessions || {};
  } catch (_) { return {}; }
}

function ok(r)      { return { success: true,  result: String(r) }; }
function fail(r)    { return { success: false, result: String(r) }; }
function wrap(s, r) { return { success: !!s,   result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
