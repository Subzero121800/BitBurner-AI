/**
 * share.js — minimal share worker for idle pservs
 *
 * ns.share() boosts your faction-rep gain rate while running. Used as
 * a fallback by scb.js's deployToPservs pass when a server has free
 * RAM but no useful hack target. Each ns.share call runs ~10s; we
 * loop forever so the bonus persists.
 *
 * RAM cost: ~4 GB. Run with as many threads as you can afford on a
 * single pserv to maximize the multiplier.
 */
/** @param {NS} ns */
export async function main(ns) {
  while (true) {
    await ns.share();
  }
}
