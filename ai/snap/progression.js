/**
 * /ai/snap/progression.js — augmentation/faction progression snapshot
 * SNAP_PROGRESSION_VERSION_1
 *
 * One-shot. Reads ns.singularity.* and writes
 * /Temp/progression-state.json. Lets the AI player avoid pulling
 * the full singularity namespace just to know how many augs are
 * pending. Static RAM ~ 12 GB at SF4-3, ~30 GB at SF4-2.
 */

const STATE_FILE = "/Temp/progression-state.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const out = {
    ts: Date.now(),
    version: "SNAP_PROGRESSION_VERSION_1",
    pendingAugs: 0,
    installedAugs: 0,
    installReady: false,
    pendingInvites: [],
    affordableAugs: [],
    factionsWithRep: []
  };

  let ownedQueued = [];
  let ownedInstalled = [];
  try { ownedQueued    = ns.singularity.getOwnedAugmentations(true) || []; } catch (_) {}
  try { ownedInstalled = ns.singularity.getOwnedAugmentations(false) || []; } catch (_) {}

  out.pendingAugs   = Math.max(0, ownedQueued.length - ownedInstalled.length);
  out.installedAugs = ownedInstalled.length;
  out.installReady  = out.pendingAugs >= 5;

  try { out.pendingInvites = ns.singularity.checkFactionInvitations() || []; }
  catch (_) {}

  const player = ns.getPlayer();
  const cash = ns.getServerMoneyAvailable("home");
  const ownedSet = new Set(ownedQueued);

  for (const fac of player.factions || []) {
    let rep = 0;
    try { rep = ns.singularity.getFactionRep(fac); } catch (_) {}
    let augs = [];
    try { augs = ns.singularity.getAugmentationsFromFaction(fac) || []; } catch (_) {}

    let cheapestAffordable = null;
    let topRepGap = Infinity;

    for (const aug of augs) {
      if (ownedSet.has(aug)) continue;
      let price = Infinity;
      let needRep = Infinity;
      try { price   = ns.singularity.getAugmentationPrice(aug); }  catch (_) {}
      try { needRep = ns.singularity.getAugmentationRepReq(aug); } catch (_) {}

      if (rep >= needRep && price <= cash) {
        if (!cheapestAffordable || price < cheapestAffordable.price) {
          cheapestAffordable = { faction: fac, aug, price, rep, needRep };
        }
      } else if (price <= cash) {
        const gap = needRep - rep;
        if (gap > 0 && gap < topRepGap) topRepGap = gap;
      }
    }

    if (cheapestAffordable) out.affordableAugs.push(cheapestAffordable);
    out.factionsWithRep.push({
      faction: fac,
      rep: Math.round(rep),
      augsAvailable: augs.length,
      nextAugRepGap: topRepGap === Infinity ? null : Math.round(topRepGap)
    });
  }

  out.affordableAugs.sort((a, b) => a.price - b.price);
  out.affordableAugs = out.affordableAugs.slice(0, 10);

  try { ns.write(STATE_FILE, JSON.stringify(out, null, 2), "w"); } catch (_) {}
}
