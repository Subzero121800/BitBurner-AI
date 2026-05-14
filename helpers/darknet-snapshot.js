/**
 * /helpers/darknet-snapshot.js — read-only Darknet (ns.dnet) probe
 * DARKNET_SNAPSHOT_VERSION_5
 *
 * v4 changes:
 *   - Remove broken ns.singularity.connect navigation (confirmed no-op for darknet servers)
 *   - Add ns.dnet.labradar() for node discovery — the game exposes known reachable nodes here
 *   - For each session, call connectToSession then probe() to capture session-scoped expansion
 *   - Expose `auth` details (model, hint, format, length) for all discovered hosts so the
 *     manager can derive the correct password without guessing
 *
 * Output shape:
 *   {
 *     ts, version,
 *     supported: bool,
 *     hasNavigator: bool,        // probe() works
 *     hasLabradar: bool,         // labradar() returned data
 *     instability: object|null,
 *     stasis: { used, limit, links: [host,...] },
 *     servers:   [ { host, depth, requiredCha, auth, blockedRam, isDarknet } ],
 *     expansion: [ { source, neighbours: [host,...] } ],
 *     labradar:  [ host, ... ]   // raw labradar output
 *   }
 */

const SNAP_FILE = "/Temp/darknet-snap.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  if (!ns.dnet) { write(ns, { supported: false }); return; }

  const out = {
    supported:    true,
    hasNavigator: false,
    hasLabradar:  false,
    instability:  null,
    stasis:       { used: 0, limit: 0, links: [] },
    servers:      [],
    expansion:    [],
    labradar:     []
  };

  try { out.instability = ns.dnet.getDarknetInstability(); } catch (_) {}
  try {
    out.stasis.links = ns.dnet.getStasisLinkedServers() || [];
    out.stasis.used  = out.stasis.links.length;
  } catch (_) {}
  try { out.stasis.limit = ns.dnet.getStasisLinkLimit(); } catch (_) {}

  const seen = new Set();
  const pushHost = (host) => {
    if (!host || seen.has(host)) return;
    seen.add(host);
    out.servers.push(describe(ns, host));
  };

  // 1) Baseline probe from current position (home → should see darkweb).
  let baseProbe = [];
  try { baseProbe = ns.dnet.probe() || []; out.hasNavigator = true; }
  catch (_) { out.hasNavigator = false; }
  if (baseProbe.length) {
    out.expansion.push({ source: "(current)", neighbours: baseProbe.slice() });
    for (const h of baseProbe) pushHost(h);
  }

  // 2) Merge crawler discovery reports (written by /helpers/darknet-crawler.js
  //    running on each authenticated server, scp'd back to home).
  //    These give us neighbours that probe() from home can never see.
  for (const f of ns.ls("home", "/Temp/darknet-disc-")) {
    try {
      const disc = JSON.parse(ns.read(f));
      if (!disc || !disc.host) continue;
      const src = disc.host;
      const neighbours = Array.isArray(disc.neighbors) ? disc.neighbors : [];
      out.expansion.push({ source: src, neighbours: neighbours.slice() });
      for (const h of neighbours) pushHost(h);
    } catch (_) {}
  }

  // 3) labradar() — the "radar" primitive; returns visible darknet nodes
  //    from the current darknet position. This is the primary discovery
  //    mechanism when probe() is limited by position.
  try {
    const lr = await ns.dnet.labradar();
    if (Array.isArray(lr)) {
      out.labradar = lr;
      out.hasLabradar = true;
    } else if (lr && typeof lr === "object") {
      // might return { hosts: [...] } or { servers: [...] }
      const arr = lr.hosts || lr.servers || lr.nodes || [];
      if (Array.isArray(arr)) { out.labradar = arr; out.hasLabradar = arr.length > 0; }
      else { out.labradar = Object.keys(lr); out.hasLabradar = out.labradar.length > 0; }
    }
  } catch (_) {}
  for (const h of out.labradar) pushHost(typeof h === "string" ? h : (h.host || String(h)));

  // 4) Stasis-linked servers (always include even if not adjacent).
  for (const host of out.stasis.links) pushHost(host);

  write(ns, out);
}


function describe(ns, host) {
  const o = { host, depth: -1, requiredCha: null, auth: null, blockedRam: null, isDarknet: null };
  try { o.depth        = ns.dnet.getDepth(host); }                       catch (_) {}
  try { o.requiredCha  = ns.dnet.getServerRequiredCharismaLevel(host); } catch (_) {}
  try { o.auth         = ns.dnet.getServerAuthDetails(host); }           catch (_) {}
  try { o.blockedRam   = ns.dnet.getBlockedRam(host); }                  catch (_) {}
  try { o.isDarknet    = ns.dnet.isDarknetServer(host); }                catch (_) {}
  return o;
}

function write(ns, payload) {
  try {
    ns.write(SNAP_FILE, JSON.stringify({
      ts: Date.now(),
      version: "DARKNET_SNAPSHOT_VERSION_5",
      ...payload
    }, null, 2), "w");
  } catch (_) {}
}
