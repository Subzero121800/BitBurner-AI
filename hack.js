/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  if (!target) { ns.tprint("usage: hack.js <target>"); return; }
  while (true) await ns.hack(target);
}
