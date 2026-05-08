/**
 * server-upgrader.js
 * UPGRADER_VERSION_12_SAVINGS_AWARE
 *
 * Fleet target scales with home RAM:
 *     target = clamp(START_RAM, cloudLimit, HOME_RAM_PCT * homeMaxRam)
 * snapped to the nearest lower power of 2.
 *
 * Each cycle the upgrader:
 *   1. Reads the savings policy from /Temp/economy.json (written by
 *      scb.js). While liquid cash < (minCashReserve + savingsTarget)
 *      ALL purchases and upgrades pause — the upgrader sleeps until
 *      cash recovers.
 *   2. Buys a fresh START_RAM pserv if a slot is open.
 *   3. Picks the smallest pserv below target and doubles its RAM
 *      (subject to the per-cycle cash-reserve guard).
 *
 * When home RAM grows the target lifts automatically — no restart.
 *
 * Standalone as of v13. Previously embedded as a template string
 * inside scb.js, which inflated scb.js's static RAM by counting every
 * cloud namespace mention in the template body.
 */

/** @param {NS} ns */
export async function main(ns) {
  const ENABLED          = true;
  const HOME_RAM_PCT     = 0.10;          // pserv cap = 10% of home max RAM
  const RESERVE_MODE     = "percent";
  const FIXED_RESERVE    = 500_000_000;
  const PERCENT_RESERVE  = 10;
  const CHECK_INTERVAL_MS = 30_000;
  const MAX_SERVERS      = ns.cloud.getServerLimit();
  const START_RAM_GB     = 8;
  const SERVER_PREFIX    = "pserv-";
  const TAIL_KEY         = "/Temp/server-upgrader-tail-open.txt";
  const ECONOMY_FILE     = "/Temp/economy.json";

  ns.disableLog("ALL");

  const self = ns.getScriptName();
  const running = ns.ps("home").filter((p) => p.filename === self);

  if (running.length > 1) {
    ns.print("WARN  Duplicate server-upgrader.js detected. Exiting.");
    return;
  }

  if (!ns.fileExists(TAIL_KEY, "home")) {
    ns.write(TAIL_KEY, "true", "w");
    try {
      ns.ui.openTail();
    } catch {}
  }

  if (!ENABLED) {
    ns.print("WARN  Server upgrader DISABLED");
    return;
  }

  while (true) {
    const owned   = ns.cloud.getServerNames();
    const money   = ns.getServerMoneyAvailable("home");
    const reserve = RESERVE_MODE === "percent"
      ? money * (PERCENT_RESERVE / 100)
      : FIXED_RESERVE;

    const econ = readEconomy(ns, ECONOMY_FILE);
    const savingsThreshold = (econ.minCashReserve || 0) + (econ.savingsTarget || 0);
    const savingsLocked = savingsThreshold > 0 && money < savingsThreshold;

    const homeMax  = ns.getServerMaxRam("home");
    const cloudCap = ns.cloud.getRamLimit();
    const target   = computeTarget(homeMax, cloudCap, HOME_RAM_PCT, START_RAM_GB);

    ns.print("─".repeat(48));
    ns.print("INFO  Server Upgrader @ " + new Date().toLocaleTimeString());
    ns.print("INFO  Owned: " + owned.length + "/" + MAX_SERVERS + " | Target: " + ns.format.ram(target) + " (10% of home " + ns.format.ram(homeMax) + ")");
    ns.print("INFO  Cash: $" + ns.format.number(money) + " | Reserve: $" + ns.format.number(reserve) + " (" + RESERVE_MODE + ")");
    ns.print("INFO  Spendable: $" + ns.format.number(Math.max(0, money - reserve)));
    if (savingsLocked) {
      ns.print("INFO  SAVINGS-LOCKED: cash $" + ns.format.number(money) + " < threshold $" + ns.format.number(savingsThreshold) + ". Skipping all purchases this cycle.");
    }
    ns.print("─".repeat(48));

    if (savingsLocked) {
      await ns.sleep(CHECK_INTERVAL_MS);
      continue;
    }

    let bought = false;

    if (owned.length < MAX_SERVERS) {
      const cost = ns.cloud.getServerCost(START_RAM_GB);
      if (money - cost >= reserve) {
        const name = nextServerName(owned, SERVER_PREFIX);
        const result = ns.cloud.purchaseServer(name, START_RAM_GB);
        if (result) {
          ns.print("SUCCESS  Bought " + result + " (" + ns.format.ram(START_RAM_GB) + ")");
          bought = true;
        } else {
          ns.print("ERROR  Purchase failed");
        }
      } else {
        ns.print("WARN  New server ($" + ns.format.number(cost) + ") exceeds budget");
      }
    }

    const refreshed = ns.cloud.getServerNames();
    const upgradeable = refreshed
      .map((srv) => ({ srv, ram: ns.getServerMaxRam(srv) }))
      .filter((s) => s.ram < target)
      .sort((a, b) => a.ram - b.ram);

    if (!bought && upgradeable.length > 0) {
      const pick    = upgradeable[0];
      const nextRam = Math.min(target, pick.ram * 2);
      const cost    = ns.cloud.getServerUpgradeCost(pick.srv, nextRam);
      const cashNow = ns.getServerMoneyAvailable("home");
      const reserveNow = RESERVE_MODE === "percent"
        ? cashNow * (PERCENT_RESERVE / 100)
        : FIXED_RESERVE;

      if (cost < 0 || cost === Infinity) {
        ns.print("WARN  " + pick.srv + " cannot compute upgrade cost");
      } else if (cashNow - cost < reserveNow) {
        ns.print("WARN  " + pick.srv + " (" + ns.format.ram(pick.ram) + " -> " + ns.format.ram(nextRam) + ") $" + ns.format.number(cost) + " exceeds budget");
      } else {
        ns.killall(pick.srv);
        const success = ns.cloud.upgradeServer(pick.srv, nextRam);
        if (success) {
          ns.print("SUCCESS  " + pick.srv + ": " + ns.format.ram(pick.ram) + " -> " + ns.format.ram(nextRam) + " $" + ns.format.number(cost));
        } else {
          ns.print("ERROR  Failed to upgrade " + pick.srv);
        }
      }
    }

    const finalOwned   = ns.cloud.getServerNames();
    const belowTarget  = finalOwned.filter((srv) => ns.getServerMaxRam(srv) < target).length;

    if (belowTarget === 0 && finalOwned.length >= MAX_SERVERS) {
      ns.print("INFO  All " + finalOwned.length + " servers at " + ns.format.ram(target) + "+. Sleeping (will re-check after home RAM grows).");
    } else if (belowTarget > 0) {
      ns.print("INFO  " + belowTarget + " server(s) still below " + ns.format.ram(target));
    }

    await ns.sleep(CHECK_INTERVAL_MS);
  }
}

function computeTarget(homeMax, cloudCap, pct, floorRam) {
  const raw    = Math.min(cloudCap, Math.max(floorRam, homeMax * pct));
  const exp    = Math.floor(Math.log2(Math.max(floorRam, raw)));
  const snapped = Math.pow(2, exp);
  return Math.max(floorRam, Math.min(snapped, cloudCap));
}

function readEconomy(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return {};
    return JSON.parse(ns.read(path)) || {};
  } catch (_) { return {}; }
}

function nextServerName(owned, prefix) {
  let index = 0;
  while (owned.includes(prefix + index)) index++;
  return prefix + index;
}
