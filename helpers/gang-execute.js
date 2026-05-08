/**
 * /helpers/gang-execute.js — apply gang actions
 * GANG_EXECUTE_VERSION_1
 *
 * One-shot. Reads /Temp/gang-pending.json and applies createGang,
 * recruitments, task assignments, ascensions, equipment purchases,
 * territory-warfare toggle. Pays the write half of ns.gang.* only
 * while running.
 *
 * Pending shape:
 *   {
 *     _reqId: "...",
 *     create:    { faction } | null,
 *     recruits:  [ "Alpha", "Bravo", ... ],
 *     tasks:     [ { name, task }, ... ],
 *     ascend:    [ "Bravo", ... ],
 *     equip:     [ { name, item }, ... ],
 *     warfare:   true | false | null
 *   }
 */

const PENDING = "/Temp/gang-pending.json";
const RESULT  = "/Temp/gang-exec-result.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let req;
  try { req = JSON.parse(ns.read(PENDING)); }
  catch (e) {
    write(ns, { ok: false, error: "bad pending: " + String(e) });
    return;
  }

  const out = { _reqId: req._reqId || null, ok: true };

  if (req.create && req.create.faction) {
    try { out.created = !!ns.gang.createGang(req.create.faction); }
    catch (e) { out.createError = String(e.message || e); }
  }

  out.recruited = 0;
  for (const name of (req.recruits || [])) {
    try { if (ns.gang.recruitMember(name)) out.recruited++; } catch (_) {}
  }

  out.tasksApplied = 0;
  for (const t of (req.tasks || [])) {
    try { if (ns.gang.setMemberTask(t.name, t.task)) out.tasksApplied++; } catch (_) {}
  }

  out.ascended = 0;
  for (const name of (req.ascend || [])) {
    try { if (ns.gang.ascendMember(name)) out.ascended++; } catch (_) {}
  }

  out.equipped = 0;
  for (const e of (req.equip || [])) {
    try { if (ns.gang.purchaseEquipment(e.name, e.item)) out.equipped++; } catch (_) {}
  }

  if (typeof req.warfare === "boolean") {
    try { ns.gang.setTerritoryWarfare(req.warfare); out.warfareSet = req.warfare; }
    catch (e) { out.warfareError = String(e.message || e); }
  }

  write(ns, out);
}

function write(ns, payload) {
  try { ns.write(RESULT, JSON.stringify({ ts: Date.now(), ...payload }), "w"); }
  catch (_) {}
}
