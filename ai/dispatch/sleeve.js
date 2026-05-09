/**
 * /ai/dispatch/sleeve.js — sleeve_task
 * DISPATCH_SLEEVE_VERSION_1
 *
 * One-shot. Static RAM ~ 32 GB without SF10-3 (8 unique
 * ns.sleeve.* @ 4 GB), ~ 4 GB at SF10-3.
 */

const REQ = "/Temp/ai-action-req.json";
const RES = "/Temp/ai-action-res.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let a;
  try { a = JSON.parse(ns.read(REQ)); }
  catch (e) { return writeRes(ns, fail("bad request: " + String(e))); }

  let res;
  try {
    if (a.action !== "sleeve_task") res = fail("sleeve: unknown action " + a.action);
    else res = exec(ns, a);
  } catch (e) { res = fail("sleeve threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

function exec(ns, a) {
  const idx = Number(a.sleeve || 0);
  let count = 0;
  try { count = ns.sleeve.getNumSleeves(); }
  catch { return fail("sleeve API unavailable (SF-10?)"); }
  if (idx < 0 || idx >= count) return fail("invalid sleeve: " + idx);

  switch (a.task) {
    case "crime": {
      const crime = normalize(ns, "crime", a.crime || "Mug");
      return wrap(ns.sleeve.setToCommitCrime(idx, crime), "sleeve " + idx + " crime " + crime);
    }
    case "faction": {
      const type = normalize(ns, "factionWork", a.type || "hacking");
      return wrap(ns.sleeve.setToFactionWork(idx, a.faction, type),
                  "sleeve " + idx + " faction " + a.faction);
    }
    case "company":
      return wrap(ns.sleeve.setToCompanyWork(idx, a.company),
                  "sleeve " + idx + " company");
    case "gym": {
      const stat = normalize(ns, "gym", a.stat || "strength");
      return wrap(ns.sleeve.setToGymWorkout(idx, a.gym || "Powerhouse Gym", stat),
                  "sleeve " + idx + " gym " + stat);
    }
    case "study": {
      const course = normalize(ns, "universityClass", a.course || "Algorithms");
      return wrap(ns.sleeve.setToUniversityCourse(idx, a.university || "Rothman University", course),
                  "sleeve " + idx + " study " + course);
    }
    case "sync":    return wrap(ns.sleeve.setToSynchronize(idx),    "sleeve " + idx + " sync");
    case "recover": return wrap(ns.sleeve.setToShockRecovery(idx), "sleeve " + idx + " recover");
    case "idle":    return wrap(ns.sleeve.setToIdle(idx),           "sleeve " + idx + " idle");
    case "bladeburner": {
      if (!a.type || !a.name) return fail("bladeburner needs {type, name}");
      return wrap(ns.sleeve.setToBladeburnerAction(idx, a.type, a.name),
                  "sleeve " + idx + " bb " + a.type + "/" + a.name);
    }
    case "travel": {
      if (!a.city) return fail("travel needs {city}");
      return wrap(ns.sleeve.travel(idx, a.city), "sleeve " + idx + " travel " + a.city);
    }
    case "buy_aug": {
      if (!a.aug) return fail("buy_aug needs {aug}");
      return wrap(ns.sleeve.purchaseSleeveAug(idx, a.aug),
                  "sleeve " + idx + " bought " + a.aug);
    }
    case "list_augs": {
      let augs = [];
      try { augs = ns.sleeve.getSleevePurchasableAugs(idx) || []; } catch (_) {}
      const top = augs.slice().sort((x, y) => x.cost - y.cost).slice(0, 10);
      return ok("sleeve " + idx + " augs: " + JSON.stringify(top));
    }
    default: return fail("unknown sleeve task: " + a.task);
  }
}

function ok(r) { return { success: true, result: String(r) }; }

function normalize(ns, kind, value) {
  const map = {
    crime:           ns.enums?.CrimeType,
    factionWork:     ns.enums?.FactionWorkType,
    universityClass: ns.enums?.UniversityClassType,
    gym:             ns.enums?.GymType
  };
  const e = map[kind];
  if (!e) return value;
  const target = String(value ?? "").toLowerCase().replace(/[\s_\-]/g, "");
  for (const v of Object.values(e)) {
    if (String(v).toLowerCase().replace(/[\s_\-]/g, "") === target) return v;
  }
  return value;
}

function wrap(s, r) { return { success: !!s, result: String(r) }; }
function fail(r)    { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
