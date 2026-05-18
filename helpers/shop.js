/**
 * /helpers/shop.js — TOR + darkweb program buying
 * SHOP_VERSION_2
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
      let torOk = false;
      try { torOk = ns.singularity.purchaseTor(); } catch (e) {
        ns.tprint("WARN  shop: purchaseTor threw: " + String(e.message || e));
      }
      if (torOk) ns.toast("TOR Router purchased", "success", 5000);
      else ns.print("INFO  shop: purchaseTor returned false (SF4 locked or already purchased?)");
    } else {
      ns.print("INFO  shop: need TOR but cash $" + cash.toFixed(0) +
               " < cost+reserve ($" + (200_000 + minReserve).toFixed(0) + ")");
    }
    // Programs require TOR; bail until next cycle.
    return;
  }

  let bought = 0;
  let skippedCash = 0;
  const missing = [];
  for (const p of PROGRAMS) {
    if (ns.fileExists(p.name, "home")) continue;
    missing.push(p.name);
    const cashNow = ns.getServerMoneyAvailable("home");
    if (cashNow - p.cost < minReserve) { skippedCash++; continue; }
    let ok = false;
    try { ok = ns.singularity.purchaseProgram(p.name); } catch (e) {
      ns.tprint("WARN  shop: purchaseProgram(" + p.name + ") threw: " + String(e.message || e));
      continue;
    }
    if (ok) {
      bought++;
      ns.toast("Bought " + p.name, "success", 5000);
      ns.tprint("SUCCESS  shop: purchased " + p.name);
    } else {
      ns.print("WARN  shop: purchaseProgram(" + p.name + ") returned false (not available yet?)");
    }
  }

  if (missing.length === 0) {
    ns.print("INFO  shop: all programs already owned");
  } else if (skippedCash > 0 && bought === 0) {
    ns.print("INFO  shop: " + missing.length + " program(s) missing, " +
             skippedCash + " skipped (insufficient cash, reserve=$" + minReserve.toFixed(0) + ")");
  }

  try {
    ns.write("/Temp/shop-last.json", JSON.stringify({
      ts:          Date.now(),
      version:     "SHOP_VERSION_2",
      bought,
      missing,
      skippedCash,
      minReserve,
      cash:        ns.getServerMoneyAvailable("home")
    }), "w");
  } catch (_) {}
}

function readJson(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return null;
    return JSON.parse(ns.read(path)) || null;
  } catch (_) { return null; }
}
