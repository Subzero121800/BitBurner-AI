/**
 * /helpers/darknet-diag.js — one-shot ns.dnet diagnostic
 * DARKNET_DIAG_VERSION_3
 *
 * Run once from the terminal:   run /helpers/darknet-diag.js
 *
 * v3: tests whether heartbleed(peek) or heartbleed(real) on darkweb
 *     reveals new nodes, dumps getServerAuthDetails + getBlockedRam,
 *     and tries nextMutation + labradar.
 *
 * Pass args to control which destructive step runs:
 *   --hb      run real heartbleed(darkweb) (default: peek only)
 *   --mut     call nextMutation()
 *   --lab     call labradar()
 */

const OUT = "/Temp/darknet-diag.json";
const SESSIONS_FILE = "/Temp/darknet-sessions.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const flags  = ns.flags([["hb", false], ["mut", false], ["lab", false]]);
  const doHbReal = !!flags.hb;
  const doMut    = !!flags.mut;
  const doLab    = !!flags.lab;

  const report = {
    ts: Date.now(),
    version: "DARKNET_DIAG_VERSION_3",
    hasDnet:  !!ns.dnet,
    startHost: null,

    // server info for darkweb
    darkwebInfo: {
      isDarknetServer:  null,
      depth:            null,
      requiredCha:      null,
      authDetails:      null,
      blockedRam:       null
    },

    // probe before any ops
    probeBefore: { false_: null, true_: null, error: null },

    // session state
    sessionUsed:    null,
    connectResult:  null,

    // heartbleed peek
    heartbleedPeek: { result: null, error: null },

    // probe after peek heartbleed
    probeAfterPeek: { false_: null, true_: null },

    // real heartbleed (only if --hb)
    heartbleedReal: { ran: false, result: null, error: null },

    // probe after real heartbleed
    probeAfterReal: { false_: null, true_: null },

    // nextMutation (only if --mut)
    nextMutation: { ran: false, result: null, error: null },

    // labradar (only if --lab)
    labradar: { ran: false, result: null, error: null },

    // misc
    instability: null,
    stasis:      { used: null, limit: null, links: null }
  };

  if (!ns.dnet) {
    finish(ns, report, "ns.dnet UNAVAILABLE");
    return;
  }

  try { report.startHost = ns.getHostname(); } catch (_) {}

  // ── darkweb server info ─────────────────────────────────────────────────────
  const dw = report.darkwebInfo;
  try { dw.isDarknetServer = ns.dnet.isDarknetServer("darkweb"); } catch (_) {}
  try { dw.depth           = ns.dnet.getDepth("darkweb"); }        catch (_) {}
  try { dw.requiredCha     = ns.dnet.getServerRequiredCharismaLevel("darkweb"); } catch (_) {}
  try { dw.authDetails     = ns.dnet.getServerAuthDetails("darkweb"); }           catch (_) {}
  try { dw.blockedRam      = ns.dnet.getBlockedRam("darkweb"); }   catch (_) {}

  // ── misc ────────────────────────────────────────────────────────────────────
  try { report.instability  = ns.dnet.getDarknetInstability(); }    catch (_) {}
  try { report.stasis.links = ns.dnet.getStasisLinkedServers() || []; report.stasis.used = report.stasis.links.length; } catch (_) {}
  try { report.stasis.limit = ns.dnet.getStasisLinkLimit(); }       catch (_) {}

  // ── probe before any ops ────────────────────────────────────────────────────
  try { report.probeBefore.false_ = ns.dnet.probe(); }
  catch (e) { report.probeBefore.error = String(e.message||e); }
  try { report.probeBefore.true_  = ns.dnet.probe(true); } catch (_) {}

  // ── reconnect to manager session if present ─────────────────────────────────
  const sessions = readSessions(ns);
  if (sessions["darkweb"]) {
    report.sessionUsed = "darkweb";
    try {
      const c = ns.dnet.connectToSession("darkweb", sessions["darkweb"]);
      report.connectResult = (c && typeof c.then === "function") ? !!(await c) : !!c;
    } catch (_) {}
  } else {
    // mint a fresh session for this diag run
    try {
      const pw = "diag3-" + Math.random().toString(36).slice(2, 10);
      const r  = ns.dnet.authenticate("darkweb", pw, 0);
      const ok = (r && typeof r.then === "function") ? !!(await r) : !!r;
      if (ok) { report.sessionUsed = "darkweb (fresh)"; report.connectResult = true; }
    } catch (_) {}
  }

  // ── heartbleed peek (always runs) ──────────────────────────────────────────
  try {
    const r = await ns.dnet.heartbleed("darkweb", { threads: 1, peek: true });
    report.heartbleedPeek.result = safeStr(r);
  } catch (e) { report.heartbleedPeek.error = String(e.message||e); }

  try { report.probeAfterPeek.false_ = ns.dnet.probe(); } catch (_) {}
  try { report.probeAfterPeek.true_  = ns.dnet.probe(true);  } catch (_) {}

  // ── real heartbleed (--hb) ─────────────────────────────────────────────────
  if (doHbReal) {
    report.heartbleedReal.ran = true;
    try {
      const r = await ns.dnet.heartbleed("darkweb", { threads: 1 });
      report.heartbleedReal.result = safeStr(r);
    } catch (e) { report.heartbleedReal.error = String(e.message||e); }

    try { report.probeAfterReal.false_ = ns.dnet.probe(); } catch (_) {}
    try { report.probeAfterReal.true_  = ns.dnet.probe(true);  } catch (_) {}
  }

  // ── nextMutation (--mut) ───────────────────────────────────────────────────
  if (doMut) {
    report.nextMutation.ran = true;
    try {
      const r = await ns.dnet.nextMutation();
      report.nextMutation.result = safeStr(r);
    } catch (e) { report.nextMutation.error = String(e.message||e); }
  }

  // ── labradar (--lab) ───────────────────────────────────────────────────────
  if (doLab) {
    report.labradar.ran = true;
    try {
      const r = await ns.dnet.labradar();
      report.labradar.result = safeStr(r);
    } catch (e) { report.labradar.error = String(e.message||e); }
  }

  finish(ns, report, null);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readSessions(ns) {
  try {
    if (!ns.fileExists(SESSIONS_FILE, "home")) return {};
    const j = JSON.parse(ns.read(SESSIONS_FILE)) || {};
    return j.sessions || {};
  } catch (_) { return {}; }
}

function safeStr(v) {
  if (v == null) return String(v);
  try { return JSON.stringify(v).slice(0, 500); } catch (_) { return String(v).slice(0, 500); }
}

function summarise(v) {
  if (v == null) return String(v);
  if (Array.isArray(v)) return "[" + v.length + "] " + JSON.stringify(v).slice(0, 300);
  return JSON.stringify(v).slice(0, 300);
}

function finish(ns, report, note) {
  try { ns.write(OUT, JSON.stringify(report, null, 2), "w"); } catch (_) {}

  const p = (s) => ns.tprint(s);
  p("─".repeat(60));
  p("INFO  darknet-diag v3  startHost=" + report.startHost);
  if (note) p("INFO  " + note);
  p("");
  p("── darkweb server info ──────────────────────────────────────");
  const dw = report.darkwebInfo;
  p("  isDarknetServer = " + dw.isDarknetServer);
  p("  depth           = " + dw.depth);
  p("  requiredCha     = " + dw.requiredCha);
  p("  authDetails     = " + safeStr(dw.authDetails));
  p("  blockedRam      = " + safeStr(dw.blockedRam));
  p("");
  p("── probe BEFORE any ops ─────────────────────────────────────");
  p("  false_ = " + summarise(report.probeBefore.false_));
  p("  true_  = " + summarise(report.probeBefore.true_));
  if (report.probeBefore.error) p("  ERROR  " + report.probeBefore.error);
  p("  sessionUsed=" + report.sessionUsed + "  connectResult=" + report.connectResult);
  p("");
  p("── heartbleed(darkweb, peek=true) ───────────────────────────");
  p("  result = " + report.heartbleedPeek.result);
  if (report.heartbleedPeek.error) p("  ERROR  " + report.heartbleedPeek.error);
  p("  probe after peek: false_=" + summarise(report.probeAfterPeek.false_) + "  true_=" + summarise(report.probeAfterPeek.true_));
  p("");
  if (report.heartbleedReal.ran) {
    p("── heartbleed(darkweb, REAL) ─────────────────────────────────");
    p("  result = " + report.heartbleedReal.result);
    if (report.heartbleedReal.error) p("  ERROR  " + report.heartbleedReal.error);
    p("  probe after real: false_=" + summarise(report.probeAfterReal.false_) + "  true_=" + summarise(report.probeAfterReal.true_));
    p("");
  }
  if (report.nextMutation.ran) {
    p("── nextMutation() ────────────────────────────────────────────");
    p("  result = " + report.nextMutation.result);
    if (report.nextMutation.error) p("  ERROR  " + report.nextMutation.error);
    p("");
  }
  if (report.labradar.ran) {
    p("── labradar() ────────────────────────────────────────────────");
    p("  result = " + report.labradar.result);
    if (report.labradar.error) p("  ERROR  " + report.labradar.error);
    p("");
  }
  p("── misc ─────────────────────────────────────────────────────");
  p("  instability = " + safeStr(report.instability));
  p("  stasis " + report.stasis.used + "/" + report.stasis.limit + " links=" + JSON.stringify(report.stasis.links));
  p("─".repeat(60));
  p("  TIP: run with --hb to do real heartbleed, --mut for nextMutation, --lab for labradar");
}
