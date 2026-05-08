/**
 * /helpers/sleeve-snapshot.js — read-only sleeve state probe
 * SLEEVE_SNAPSHOT_VERSION_1
 *
 * One-shot. Reads every sleeve's info / current task / purchasable
 * augs and writes /Temp/sleeve-snap.json. Pays the read half of
 * ns.sleeve.* (~16 GB) only while running.
 */

const SNAP_FILE = "/Temp/sleeve-snap.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let n = 0;
  try { n = ns.sleeve.getNumSleeves(); }
  catch (_) {
    write(ns, { count: 0, error: "no SF-10" });
    return;
  }
  if (!n) { write(ns, { count: 0, sleeves: [] }); return; }

  const sleeves = [];
  for (let i = 0; i < n; i++) {
    let info = null, task = null, augs = [];
    try { info = ns.sleeve.getInformation(i); } catch (_) {}
    try { task = ns.sleeve.getTask(i); } catch (_) {}
    try { augs = ns.sleeve.getSleevePurchasableAugs(i) || []; } catch (_) {}
    sleeves.push({
      idx:  i,
      info,
      task,
      augs: augs.map((a) => ({ name: a.name, cost: a.cost }))
    });
  }
  write(ns, { count: n, sleeves });
}

function write(ns, payload) {
  try {
    ns.write(SNAP_FILE, JSON.stringify({
      ts: Date.now(),
      version: "SLEEVE_SNAPSHOT_VERSION_1",
      ...payload
    }, null, 2), "w");
  } catch (_) {}
}
