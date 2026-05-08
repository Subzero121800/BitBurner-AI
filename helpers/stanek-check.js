/**
 * /helpers/stanek-check.js — Stanek's Gift active-fragments probe
 * STANEK_CHECK_VERSION_1
 *
 * One-shot. Calls ns.stanek.activeFragments and writes the result to
 * /Temp/stanek-state.json. scb.js reads that snapshot in
 * launchCompanions to decide whether to skip Stanek-dependent
 * companions. Static RAM ~ 4 GB only while running.
 */

const STATE_FILE = "/Temp/stanek-state.json";

/** @param {NS} ns */
export async function main(ns) {
  let active = false;
  let count = 0;
  try {
    const fragments = ns.stanek.activeFragments();
    count = Array.isArray(fragments) ? fragments.length : 0;
    active = count > 0;
  } catch (_) {}

  try {
    ns.write(STATE_FILE, JSON.stringify({
      ts: Date.now(),
      version: "STANEK_CHECK_VERSION_1",
      active,
      fragmentCount: count
    }, null, 2), "w");
  } catch (_) {}
}
