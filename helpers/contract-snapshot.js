/**
 * /helpers/contract-snapshot.js — finds and reads coding contracts
 * CONTRACT_SNAPSHOT_VERSION_1
 *
 * One-shot. Walks the network, lists every .cct file, reads its
 * type and data. Writes /Temp/contracts-snap.json. Pays the read
 * half of the codingcontract namespace (~10 GB) only while running.
 */

const SNAP_FILE = "/Temp/contracts-snap.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const servers = deepScan(ns);
  const contracts = [];
  for (const host of servers) {
    let files = [];
    try { files = ns.ls(host, ".cct") || []; } catch (_) {}
    for (const name of files) {
      let type = null;
      let data = null;
      try { type = ns.codingcontract.getContractType(name, host); } catch (_) {}
      try { data = ns.codingcontract.getData(name, host); } catch (_) {}
      contracts.push({ host, name, type, data });
    }
  }
  try {
    ns.write(SNAP_FILE, JSON.stringify({
      ts: Date.now(),
      version: "CONTRACT_SNAPSHOT_VERSION_1",
      count: contracts.length,
      contracts
    }, null, 2), "w");
  } catch (_) {}
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
