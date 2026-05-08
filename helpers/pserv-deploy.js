/**
 * /helpers/pserv-deploy.js — purchased-server worker deployment
 * PSERV_DEPLOY_VERSION_1
 *
 * One-shot. Sweeps purchased servers; for each one deploys
 * hack/grow/weaken against the best target, or falls back to share()
 * if no hackable target exists. Static RAM costs ns.cloud.* + the
 * basic exec/scp/ps surface only while running.
 *
 * Reads /Temp/network-state.json for the target ranking (written by
 * /ai/snap/network.js); if missing or stale, picks a default target.
 */

const SHARE = "share.js";
const HACK  = "hack.js";
const GROW  = "grow.js";
const WEAK  = "weaken.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  ensureWorker(ns, HACK,  "ns.hack");
  ensureWorker(ns, GROW,  "ns.grow");
  ensureWorker(ns, WEAK,  "ns.weaken");
  ensureShareWorker(ns,   SHARE);

  let owned = [];
  try { owned = ns.cloud.getServerNames(); } catch (_) { return; }
  if (!owned.length) return;

  const target = pickTargetFromSnap(ns) || "n00dles";
  let deployed = 0;
  let shared   = 0;

  for (const host of owned) {
    if (deployHackScripts(ns, host, target)) { deployed++; continue; }

    let free = 0;
    try { free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host); }
    catch (_) { continue; }
    let shareCost = 4;
    try { shareCost = ns.getScriptRam(SHARE, "home") || 4; } catch (_) {}
    if (free < shareCost) continue;

    const ps = ns.ps(host);
    const hasWorkers = ps.some((p) =>
      p.filename === HACK || p.filename === GROW || p.filename === WEAK
    );
    if (hasWorkers) continue;
    if (ps.some((p) => p.filename === SHARE)) continue;

    try { ns.scp(SHARE, host, "home"); } catch (_) { continue; }
    const threads = Math.floor(free / shareCost);
    if (threads < 1) continue;
    if (ns.exec(SHARE, host, threads) > 0) shared++;
  }

  try {
    ns.write("/Temp/pserv-deploy-last.json", JSON.stringify({
      ts: Date.now(),
      version: "PSERV_DEPLOY_VERSION_1",
      deployed, shared, target
    }), "w");
  } catch (_) {}
}

function deployHackScripts(ns, host, target) {
  try { ns.scp([HACK, GROW, WEAK], host, "home"); } catch { return false; }

  const free = (ns.getServerMaxRam(host) || 0) - (ns.getServerUsedRam(host) || 0);
  if (free < 4) return false;

  const wRam = ns.getScriptRam(WEAK, "home") || 1.75;
  const gRam = ns.getScriptRam(GROW, "home") || 1.75;
  const hRam = ns.getScriptRam(HACK, "home") || 1.7;

  const wT = Math.max(1, Math.floor((free * 0.5) / wRam));
  const gT = Math.max(1, Math.floor((free * 0.3) / gRam));
  const hT = Math.max(1, Math.floor((free * 0.2) / hRam));

  // Don't restack if already running (filename match — args check requires
  // a heavier API surface and isn't worth it here).
  const ps = ns.ps(host);
  const already = (file) => ps.some((p) => p.filename === file);

  let any = false;
  if (!already(WEAK) && ns.exec(WEAK, host, wT, target) > 0) any = true;
  if (!already(GROW) && ns.exec(GROW, host, gT, target) > 0) any = true;
  if (!already(HACK) && ns.exec(HACK, host, hT, target) > 0) any = true;
  return any;
}

function pickTargetFromSnap(ns) {
  try {
    if (!ns.fileExists("/Temp/network-state.json", "home")) return null;
    const snap = JSON.parse(ns.read("/Temp/network-state.json")) || {};
    const targets = Array.isArray(snap.targets) ? snap.targets : [];
    return targets[0]?.name || null;
  } catch (_) { return null; }
}

function ensureWorker(ns, file, op) {
  if (ns.fileExists(file, "home")) return;
  const body = "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await " + op + "(t);}";
  ns.write(file, body, "w");
}

function ensureShareWorker(ns, file) {
  if (ns.fileExists(file, "home")) return;
  ns.write(file, "/** @param {NS} ns */ export async function main(ns){while(true)await ns.share();}", "w");
}
