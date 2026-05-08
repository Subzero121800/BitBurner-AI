/**
 * /helpers/shop.js — TOR + darkweb program buying
 * SHOP_VERSION_1
 *
 * One-shot. Reads /Temp/economy.json for the cash floor, buys TOR
 * if affordable, then sweeps the program list and buys whatever the
 * cash reserve allows. Exits. Static RAM costs the singularity
 * namespace (purchaseTor, purchaseProgram) only while running.
 *
 * Replaces scb.js's inline buyToolsIfAffordable. scb.js spawns this
 * helper each cycle instead of paying singularity RAM resident.
 */

const ECON_FILE = "/Temp/economy.json";

const PROGRAMS = [
  { name: "BruteSSH.exe",       cost:        500_000 },
  { name: "FTPCrack.exe",       cost:      1_500_000 },
  { name: "relaySMTP.exe",      cost:      5_000_000 },
  { name: "HTTPWorm.exe",       cost:     30_000_000 },
  { name: "SQLInject.exe",      cost:    250_000_000 },
  { name: "ServerProfiler.exe", cost:        500_000 },
  { name: "DeepscanV1.exe",     cost:        500_000 },
  { name: "DeepscanV2.exe",     cost:     25_000_000 },
  { name: "AutoLink.exe",       cost:      1_000_000 },
  { name: "Formulas.exe",       cost:  5_000_000_000 }
];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const econ = readJson(ns, ECON_FILE) || {};
  const minReserve = Number(econ.minCashReserve) || 0;
  const cash = ns.getServerMoneyAvailable("home");

  if (!ns.hasTorRouter()) {
    if (cash - 200_000 >= minReserve) {
      if (ns.singularity.purchaseTor()) {
        ns.toast("TOR Router purchased", "success", 5000);
      }
    }
    // Programs require TOR; bail until next cycle.
    return;
  }

  let bought = 0;
  for (const p of PROGRAMS) {
    if (ns.fileExists(p.name, "home")) continue;
    const cashNow = ns.getServerMoneyAvailable("home");
    if (cashNow - p.cost < minReserve) continue;
    if (ns.singularity.purchaseProgram(p.name)) {
      bought++;
      ns.toast("Bought " + p.name, "success", 5000);
    }
  }

  if (bought > 0) {
    try {
      ns.write("/Temp/shop-last.json", JSON.stringify({
        ts: Date.now(),
        version: "SHOP_VERSION_1",
        bought
      }), "w");
    } catch (_) {}
  }
}

function readJson(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return null;
    return JSON.parse(ns.read(path)) || null;
  } catch (_) { return null; }
}
