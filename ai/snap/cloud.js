/**
 * /ai/snap/cloud.js — purchased-server fleet snapshot
 * SNAP_CLOUD_VERSION_1
 *
 * One-shot. Reads ns.cloud.* + per-server RAM stats, writes
 * /Temp/cloud-state.json. Includes valid upgrades pre-computed so
 * the player and singularity helpers don't have to recompute.
 * Static RAM ~ 13 GB (the ns.cloud.* namespace).
 */

const STATE_FILE = "/Temp/cloud-state.json";
const ECON_FILE  = "/Temp/economy.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const owned = safe(() => ns.cloud.getServerNames()) || [];
  const limit = safe(() => ns.cloud.getServerLimit()) || 0;
  const ramLimit = safe(() => ns.cloud.getRamLimit()) || 0;
  const cash = ns.getServerMoneyAvailable("home");
  const econ = readEconomy(ns);
  const minReserve = econ.minCashReserve || 0;

  const purchased = owned.map((name) => {
    const maxRam = safe(() => ns.getServerMaxRam(name)) || 0;
    const usedRam = safe(() => ns.getServerUsedRam(name)) || 0;
    const free = Math.max(0, maxRam - usedRam);
    const nextRam = Math.min(maxRam * 2, ramLimit);
    const upCost = nextRam > maxRam
      ? safe(() => ns.cloud.getServerUpgradeCost(name, nextRam))
      : Infinity;
    return { name, maxRam, usedRam, freeRam: free, nextRam, upgradeCost: upCost };
  });

  const validUpgrades = purchased
    .filter((p) => p.nextRam > p.maxRam)
    .filter((p) => Number.isFinite(p.upgradeCost) && p.upgradeCost > 0)
    .filter((p) => cash - p.upgradeCost >= minReserve)
    .map((p) => ({ server: p.name, current: p.maxRam, nextRam: p.nextRam, cost: p.upgradeCost }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 10);

  const homeMax = safe(() => ns.getServerMaxRam("home")) || 0;
  const homeUsed = safe(() => ns.getServerUsedRam("home")) || 0;
  const homeReserve = 256;
  const homeFree = Math.max(0, homeMax - homeUsed - homeReserve);

  const ranked = [
    { server: "home", maxRam: homeMax, usedRam: homeUsed, reserve: homeReserve, freeRam: homeFree },
    ...purchased.map((p) => ({
      server: p.name, maxRam: p.maxRam, usedRam: p.usedRam, reserve: 0, freeRam: p.freeRam
    }))
  ].sort((a, b) => b.freeRam - a.freeRam || b.maxRam - a.maxRam);

  const totalFreeRam = ranked.reduce((s, r) => s + r.freeRam, 0);
  const bestServer = ranked[0]?.freeRam >= 8 ? ranked[0].server : null;

  const snapshot = {
    ts: Date.now(),
    version: "SNAP_CLOUD_VERSION_1",
    serverFleet: {
      ownedCount: owned.length,
      limit,
      atLimit: owned.length >= limit,
      maxRamLimit: ramLimit,
      validUpgrades
    },
    purchasedServers: purchased.map((p) => ({
      name: p.name, maxRam: p.maxRam, usedRam: p.usedRam, freeRam: p.freeRam
    })),
    workers: {
      totalFreeRam,
      minHackRam: 8,
      bestServer,
      servers: ranked
    }
  };

  try { ns.write(STATE_FILE, JSON.stringify(snapshot, null, 2), "w"); } catch (_) {}
}

function safe(fn) { try { return fn(); } catch (_) { return null; } }

function readEconomy(ns) {
  try {
    if (!ns.fileExists(ECON_FILE, "home")) return {};
    return JSON.parse(ns.read(ECON_FILE)) || {};
  } catch (_) { return {}; }
}
