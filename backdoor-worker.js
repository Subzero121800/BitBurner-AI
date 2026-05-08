/**
 * backdoor-worker.js
 * BACKDOOR_WORKER_VERSION_1
 *
 * One-shot worker spawned by scb.js per server in the backdoor queue.
 * Walks the connect chain to the target and runs installBackdoor.
 * Standalone as of scb.js v13 — was embedded as a string template
 * before, which inflated scb.js's static RAM.
 *
 * args: [hostname, JSON path array]
 */

/** @param {NS} ns */
export async function main(ns) {
  const hostname = ns.args[0];
  const path = JSON.parse(ns.args[1]);
  ns.singularity.connect("home");
  for (const hop of path) ns.singularity.connect(hop);
  await ns.singularity.installBackdoor();
  ns.tprint("SUCCESS  Backdoored: " + hostname);
  ns.singularity.connect("home");
}
