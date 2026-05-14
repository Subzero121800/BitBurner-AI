/**
 * /helpers/darknet-crawler.js — self-replicating darknet node crawler
 * DARKNET_CRAWLER_VERSION_1
 *
 * Deploy once onto darkweb (from darknet-manager.js). After that it
 * spreads itself to every server it can authenticate.
 *
 * Each instance runs a probe/auth/spread loop from its local position,
 * then scps a discovery report back to home so the manager can see
 * the full network topology.
 *
 * Password models:
 *   ZeroLogon — empty string (confirmed)
 *   (others)  — attempt empty string, log heartbleed hint for manual review
 */

const CRAWLER   = "/helpers/darknet-crawler.js";
const DISC_DIR  = "/Temp/";
const LOOP_MS   = 30_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const myHost = ns.getHostname();
  ns.print("INFO  darknet-crawler up on " + myHost);

  while (true) {
    try { await crawl(ns, myHost); }
    catch (e) { ns.print("WARN  crawl: " + String(e.message || e)); }
    await ns.sleep(LOOP_MS);
  }
}

async function crawl(ns, myHost) {
  let neighbors = [];
  try { neighbors = ns.dnet.probe() || []; } catch (_) { return; }

  const disc = { ts: Date.now(), host: myHost, neighbors, discoveries: [] };

  for (const host of neighbors) {
    let details = {};
    try { details = ns.dnet.getServerAuthDetails(host) || {}; } catch (_) {}

    if (details.isOnline === false || details.isConnectedToCurrentServer === false) continue;

    const entry = { host, modelId: details.modelId || null, authenticated: false };

    if (details.hasSession) {
      entry.authenticated = true;
      disc.discoveries.push(entry);
      await spread(ns, host);
      continue;
    }

    const pw = solvePassword(details);
    let r = null;
    try { r = await ns.dnet.authenticate(host, pw, 0); } catch (_) {}

    if (r?.success) {
      entry.authenticated = true;
      ns.tprint("SUCCESS  crawler: authenticated " + host + " (model=" + details.modelId + ") on " + myHost);
      await spread(ns, host);
    } else {
      // Peek heartbleed logs to surface password hints
      try {
        const hb = await ns.dnet.heartbleed(host, { threads: 1, peek: true });
        if (hb?.logs) ns.print("INFO  heartbleed " + host + " hint: " + String(hb.logs).slice(0, 300));
      } catch (_) {}
    }

    disc.discoveries.push(entry);
  }

  // Write report and ship back to home
  const reportFile = DISC_DIR + "darknet-disc-" + myHost + ".json";
  try { ns.write(reportFile, JSON.stringify(disc), "w"); } catch (_) {}
  try { ns.scp(reportFile, "home"); } catch (_) {}
}

async function spread(ns, host) {
  try { ns.scp(CRAWLER, host); } catch (_) {}
  try {
    ns.exec(CRAWLER, host, { preventDuplicates: true });
  } catch (_) {
    // fallback: some Bitburner versions need threads as a number
    try { ns.exec(CRAWLER, host, 1); } catch (_) {}
  }
}

function solvePassword(details) {
  const model = String(details?.modelId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (model) {
    case "zerologon": return "";
    default:          return "";
  }
}
