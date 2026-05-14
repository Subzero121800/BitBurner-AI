/**
 * /helpers/darknet-execute.js — applies a batch of Darknet actions
 * DARKNET_EXECUTE_VERSION_1
 *
 * One-shot. Reads /Temp/darknet-pending.json (batch written by the
 * slim darknet-manager.js orchestrator), reconnects to any sessions
 * via /Temp/darknet-sessions.json (host -> password, populated by the
 * manager when it authenticates), applies the batch, writes
 * /Temp/darknet-exec-result.json with counts. Pays the heavy half of
 * ns.dnet.* only while running.
 *
 * Pending shape:
 *   {
 *     _reqId: "...",
 *     ops: [
 *       { op: "heartbleed",  host, threads?, peek? },
 *       { op: "phishing",    host?, threads? },     // host = where to exec
 *       { op: "memreal",     host },
 *       { op: "migrate",     host, threads? },
 *       { op: "stasis_set",  host },
 *       { op: "open_cache",  filename, suppressToast? },
 *       { op: "pump_dump",   symbol, threads? }
 *     ]
 *   }
 *
 * All ops are best-effort — failures are recorded but don't abort the batch.
 */

const PENDING  = "/Temp/darknet-pending.json";
const RESULT   = "/Temp/darknet-exec-result.json";
const SESSIONS = "/Temp/darknet-sessions.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!ns.dnet) { write(ns, { ok: false, error: "ns.dnet unavailable" }); return; }

  let req;
  try { req = JSON.parse(ns.read(PENDING)); }
  catch (e) { write(ns, { ok: false, error: "bad pending: " + String(e) }); return; }

  const sessions = readSessions(ns);
  let applied = 0;
  const errors = [];
  const ops = req.ops || [];

  for (const op of ops) {
    try {
      if (op.host && sessions[op.host] && op.op !== "open_cache" && op.op !== "pump_dump") {
        try { ns.dnet.connectToSession(op.host, sessions[op.host]); } catch (_) {}
      }
      if (await apply(ns, op)) applied++;
    } catch (e) {
      errors.push(op.op + (op.host ? "/" + op.host : "") + ": " + String(e.message || e));
    }
  }

  write(ns, {
    _reqId: req._reqId || null,
    ok: true,
    applied,
    total: ops.length,
    errors: errors.slice(0, 20)
  });
}

async function apply(ns, op) {
  switch (op.op) {
    case "heartbleed": {
      const t = Math.max(1, Number(op.threads) || 1);
      const opts = { threads: t };
      if (op.peek) opts.peek = true;
      const r = await ns.dnet.heartbleed(op.host, opts);
      return r != null;
    }
    case "phishing": {
      const t = Math.max(1, Number(op.threads) || 1);
      const r = await ns.dnet.phishingAttack({ threads: t });
      return r != null;
    }
    case "memreal":
      return !!(await ns.dnet.memoryReallocation(op.host));
    case "migrate": {
      const t = Math.max(1, Number(op.threads) || 1);
      return !!(await ns.dnet.induceServerMigration(op.host, { threads: t }));
    }
    case "stasis_set":
      return !!ns.dnet.setStasisLink(op.host);
    case "open_cache":
      return !!ns.dnet.openCache(op.filename, !!op.suppressToast);
    case "pump_dump": {
      const t = Math.max(1, Number(op.threads) || 1);
      const fn = ns.dnet.promoteStock || ns.dnet.pumpDump;
      if (!fn) return false;
      return !!(await fn.call(ns.dnet, op.symbol, { threads: t }));
    }
    default:
      return false;
  }
}

function readSessions(ns) {
  try {
    if (!ns.fileExists(SESSIONS, "home")) return {};
    const j = JSON.parse(ns.read(SESSIONS)) || {};
    return j.sessions || {};
  } catch (_) { return {}; }
}

function write(ns, payload) {
  try { ns.write(RESULT, JSON.stringify({ ts: Date.now(), ...payload }), "w"); }
  catch (_) {}
}
