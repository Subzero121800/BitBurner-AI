/**
 * /helpers/gang-snapshot.js — read-only gang state probe
 * GANG_SNAPSHOT_VERSION_1
 *
 * One-shot. Reads gang info, member info, equipment catalogue, task
 * stats, all-gang power table. Writes /Temp/gang-snap.json. Pays the
 * read half of ns.gang.* (~22 GB) only while running.
 */

const SNAP_FILE = "/Temp/gang-snap.json";

const SPECIAL_TASKS = ["Unassigned", "Vigilante Justice", "Territory Warfare",
                       "Train Combat", "Train Hacking", "Train Charisma"];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let inGang = false;
  try { inGang = ns.gang.inGang(); }
  catch (_) {
    write(ns, { inGang: false, error: "no SF-2" });
    return;
  }

  if (!inGang) { write(ns, { inGang: false }); return; }

  const snap = { inGang: true };
  try { snap.info = ns.gang.getGangInformation(); } catch (_) { snap.info = null; }
  try { snap.bonusTime = ns.gang.getBonusTime() || 0; } catch (_) { snap.bonusTime = 0; }
  try { snap.canRecruit = !!ns.gang.canRecruitMember(); } catch (_) { snap.canRecruit = false; }

  let memberNames = [];
  try { memberNames = ns.gang.getMemberNames() || []; } catch (_) {}

  const members = [];
  for (const n of memberNames) {
    let info = null, ascend = null;
    try { info   = ns.gang.getMemberInformation(n); } catch (_) {}
    try { ascend = ns.gang.getAscensionResult(n); }   catch (_) {}
    members.push({ name: n, info, ascend });
  }
  snap.members = members;

  // Task catalogue
  let taskNames = [];
  try { taskNames = ns.gang.getTaskNames() || []; } catch (_) {}
  const tasks = {};
  for (const tn of taskNames) {
    if (SPECIAL_TASKS.includes(tn)) continue;
    try { tasks[tn] = ns.gang.getTaskStats(tn); } catch (_) {}
  }
  snap.tasks = tasks;

  // Equipment catalogue
  let equipNames = [];
  try { equipNames = ns.gang.getEquipmentNames() || []; } catch (_) {}
  const equipment = [];
  for (const en of equipNames) {
    try {
      equipment.push({
        name: en,
        cost: ns.gang.getEquipmentCost(en),
        type: ns.gang.getEquipmentType ? ns.gang.getEquipmentType(en) : "Equipment"
      });
    } catch (_) {}
  }
  equipment.sort((a, b) => (a.cost || 0) - (b.cost || 0));
  snap.equipment = equipment;

  // Cross-gang power table (for territory decisions)
  try { snap.allGangs = ns.gang.getAllGangInformation(); } catch (_) { snap.allGangs = null; }

  write(ns, snap);
}

function write(ns, payload) {
  try {
    ns.write(SNAP_FILE, JSON.stringify({
      ts: Date.now(),
      version: "GANG_SNAPSHOT_VERSION_1",
      ...payload
    }, null, 2), "w");
  } catch (_) {}
}
