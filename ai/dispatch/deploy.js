/**
 * /ai/dispatch/deploy.js — hack/grow/weaken/deploy_hack
 * DISPATCH_DEPLOY_VERSION_2_HOME_EXCLUDED
 *
 * One-shot. Reads /Temp/ai-action-req.json, writes
 * /Temp/ai-action-res.json. Static RAM ~ 8 GB.
 *
 * v2: home is excluded from the worker pool when any purchased or
 * rooted external server exists. Stops the AI from hallucinating
 * "server":"home" deploys that fail because home is loaded with
 * orchestrator scripts.
 */

const REQ = "/Temp/ai-action-req.json";
const RES = "/Temp/ai-action-res.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let action;
  try { action = JSON.parse(ns.read(REQ)); }
  catch (e) { return writeRes(ns, fail("bad request: " + String(e))); }

  let res;
  try {
    switch (action.action) {
      case "hack":
      case "grow":
      case "weaken":
        res = deployBasic(ns, action.target, action.action);
        break;
      case "deploy_hack":
        res = deploySmartSplit(ns, action.target, action.server);
        break;
      default:
        res = fail("deploy: unknown action " + action.action);
    }
  } catch (e) { res = fail("deploy threw: " + String(e)); }
  writeRes(ns, res, action._reqId);
}

function deployBasic(ns, target, op) {
  if (!target || !serverExists(ns, target)) return fail("invalid target: " + target);
  if (!ns.hasRootAccess(target)) return fail("no root on " + target);

  const file = op === "hack" ? "hack.js" : op === "grow" ? "grow.js" : "weaken.js";
  ensureLoopWorker(ns, file);
  const server = pickBestWorkerServer(ns, file);
  if (!server) return fail("no worker server has free RAM for " + file);
  copyIfNeeded(ns, file, server);

  const free = freeRam(ns, server);
  const cost = scriptRam(ns, file);
  const threads = Math.floor(free / cost);
  if (threads < 1) return fail(server + " has no free RAM for " + file);

  const pid = ns.exec(file, server, threads, target);
  if (pid <= 0) return fail("exec failed: " + file + " on " + server);
  return ok(op + " " + target + " x" + threads + " on " + server);
}

function deploySmartSplit(ns, target, requestedServer) {
  if (!target || !serverExists(ns, target)) return fail("invalid target: " + target);
  if (!ns.hasRootAccess(target)) return fail("no root on " + target);

  ensureLoopWorker(ns, "hack.js");
  ensureLoopWorker(ns, "grow.js");
  ensureLoopWorker(ns, "weaken.js");

  const requestedUsable =
    requestedServer &&
    serverExists(ns, requestedServer) &&
    freeRam(ns, requestedServer) >= minSplitRam(ns);

  const server = requestedUsable
    ? requestedServer
    : pickBestWorkerServer(ns, "weaken.js");
  if (!server) return fail("no worker server has enough free RAM for split deploy");

  for (const f of ["hack.js", "grow.js", "weaken.js"]) copyIfNeeded(ns, f, server);

  const free = freeRam(ns, server);
  if (free < minSplitRam(ns)) return fail(server + " has insufficient free RAM: " + ns.format.ram(free));

  killWorkerSet(ns, server);

  const wRam = scriptRam(ns, "weaken.js");
  const gRam = scriptRam(ns, "grow.js");
  const hRam = scriptRam(ns, "hack.js");

  let wT = Math.floor((free * 0.5) / wRam);
  let gT = Math.floor((free * 0.3) / gRam);
  let hT = Math.floor((free * 0.2) / hRam);

  if (wT < 1 && free >= wRam) wT = 1;
  if (gT < 1 && free >= gRam + wT * wRam) gT = 1;
  if (hT < 1 && free >= hRam + wT * wRam + gT * gRam) hT = 1;

  const launched = [];
  if (wT > 0 && ns.exec("weaken.js", server, wT, target) > 0) launched.push("W:" + wT);
  if (gT > 0 && ns.exec("grow.js",   server, gT, target) > 0) launched.push("G:" + gT);
  if (hT > 0 && ns.exec("hack.js",   server, hT, target) > 0) launched.push("H:" + hT);

  if (!launched.length) return fail("no workers launched on " + server);
  const redirect = requestedServer && requestedServer !== server
    ? " redirected from " + requestedServer
    : "";
  return ok("deployed " + target + " on " + server + " " + launched.join(" ") + redirect);
}

function ensureLoopWorker(ns, file) {
  const bodies = {
    "hack.js":   "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.hack(t);}",
    "grow.js":   "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.grow(t);}",
    "weaken.js": "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.weaken(t);}"
  };
  if (!ns.fileExists(file, "home")) ns.write(file, bodies[file], "w");
}

function pickBestWorkerServer(ns, requiredScript) {
  const servers = getWorkerServers(ns);
  // For a "deploy_hack" split, we need at least one thread of each
  // worker (~5.2 GB total). Picking a server that only fits one
  // weaken thread would just fail at the next check, so gate higher.
  const minUseful = Math.max(scriptRam(ns, requiredScript), minSplitRam(ns));
  return servers
    .filter((s) => serverExists(ns, s))
    .map((s) => ({ s, free: freeRam(ns, s), max: safe(() => ns.getServerMaxRam(s)) || 0 }))
    .filter((x) => x.free >= minUseful)
    .sort((a, b) => b.free - a.free || b.max - a.max)[0]?.s || null;
}

// Worker pool: prefer purchased servers and rooted external hosts.
// Home is only used as a fallback when no other host has been purchased
// or rooted yet — once even one pserv exists, leave home alone for
// scb.js / managers / the player itself. This stops the AI from
// hallucinating "server":"home" deploys that fight the orchestrator.
function getWorkerServers(ns) {
  const purchased = safe(() => ns.cloud.getServerNames()) || [];
  const rooted = deepScan(ns)
    .filter((s) => s !== "home")
    .filter((s) => !s.startsWith("hacknet"))
    .filter((s) => ns.hasRootAccess(s))
    .filter((s) => (safe(() => ns.getServerMaxRam(s)) || 0) > 0);

  const pool = [...new Set([...purchased, ...rooted])];
  return pool.length > 0 ? pool : ["home"];
}

function freeRam(ns, server) {
  const reserve = server === "home" ? 256 : 0;
  return Math.max(0, ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserve);
}
function scriptRam(ns, file) { return ns.getScriptRam(file, "home") || 1.75; }
function minSplitRam(ns) { return scriptRam(ns, "weaken.js") + scriptRam(ns, "grow.js") + scriptRam(ns, "hack.js"); }
function copyIfNeeded(ns, file, server) {
  if (server !== "home" && !ns.fileExists(file, server)) ns.scp(file, server, "home");
}
function killWorkerSet(ns, server) {
  for (const proc of ns.ps(server)) {
    if (["hack.js", "grow.js", "weaken.js"].includes(proc.filename)) ns.kill(proc.pid);
  }
}
function serverExists(ns, server) {
  try { ns.getServer(server); return true; } catch { return false; }
}
function deepScan(ns) {
  const visited = new Set();
  const queue = ["home"];
  while (queue.length) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const n of ns.scan(cur)) if (!visited.has(n)) queue.push(n);
  }
  return [...visited];
}

function ok(result)   { return { success: true,  result: String(result) }; }
function fail(result) { return { success: false, result: String(result) }; }
function safe(fn) { try { return fn(); } catch (_) { return null; } }

function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
