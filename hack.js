/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  if (!target) { ns.tprint("usage: hack.js <target>"); return; }
  while (true) {
    if (!ns.hasRootAccess(target)) {
      ns.print("WARN  no root on " + target + " — exiting");
      return;
    }
    await ns.hack(target);
  }
}
