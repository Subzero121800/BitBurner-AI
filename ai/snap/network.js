/**
 * /ai/snap/network.js — network/topology snapshot
 * SNAP_NETWORK_VERSION_1
 *
 * One-shot. Walks the network, ranks hackable targets, writes
 * /Temp/network-state.json. Launched periodically by scb.js so the
 * AI player can read network/targets without paying the scan cost
 * itself. Static RAM ~ 5 GB.
 */

const STATE_FILE = "/Temp/network-state.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const player = ns.getPlayer();
  const all = deepScan(ns);

  const servers = all.map((name) => {
    let info = null;
    try { info = perServer(ns, name); } catch (_) {}
    return info;
  }).filter(Boolean);

  const rooted = servers.filter((s) => s.rooted).map((s) => s.name);

  const targets = servers
    .filter((s) => s.name !== "home")
    .filter((s) => !s.name.startsWith("hacknet"))
    .filter((s) => !s.name.startsWith("pserv"))
    .filter((s) => !s.name.startsWith("ai-pserv"))
    .filter((s) => s.rooted)
    .filter((s) => s.maxMoney > 0)
    .filter((s) => s.requiredHacking <= player.skills.hacking)
    .map((s) => ({
      name: s.name,
      maxMoney: s.maxMoney,
      money: s.money,
      moneyRatio: s.maxMoney > 0 ? s.money / s.maxMoney : 0,
      minSecurity: s.minSec,
      security: s.sec,
      requiredHacking: s.requiredHacking,
      score: s.maxMoney / Math.max(1, s.minSec)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const snapshot = {
    ts: Date.now(),
    version: "SNAP_NETWORK_VERSION_1",
    totalServers: all.length,
    rootedServers: rooted.length,
    rooted: rooted.slice(0, 50),
    targets
  };
  try { ns.write(STATE_FILE, JSON.stringify(snapshot, null, 2), "w"); } catch (_) {}
}

function perServer(ns, name) {
  return {
    name,
    rooted:          ns.hasRootAccess(name),
    maxMoney:        ns.getServerMaxMoney(name),
    money:           ns.getServerMoneyAvailable(name),
    minSec:          ns.getServerMinSecurityLevel(name),
    sec:             ns.getServerSecurityLevel(name),
    requiredHacking: ns.getServerRequiredHackingLevel(name)
  };
}

function deepScan(ns) {
  const visited = new Set();
  const queue = ["home"];
  while (queue.length) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of ns.scan(cur)) if (!visited.has(next)) queue.push(next);
  }
  return [...visited];
}
