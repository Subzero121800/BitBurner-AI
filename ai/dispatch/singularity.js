/**
 * /ai/dispatch/singularity.js — all ns.singularity.* actions
 * DISPATCH_SINGULARITY_VERSION_1
 *
 * One-shot. Handles travel, connect, backdoor, work_company,
 * work_faction, study, gym, commit_crime, buy_program,
 * buy_augmentation, install_augmentations, soft_reset,
 * join_faction, donate_faction. Static RAM ~ 12 GB (SF4-3) /
 * ~30 GB (SF4-2) / ~120 GB (SF4-1).
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
  try { res = await run(ns, a); }
  catch (e) { res = fail("singularity threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

async function run(ns, a) {
  switch (a.action) {
    case "travel":
      return wrap(ns.singularity.travelToCity(a.city), "travel " + a.city);

    case "connect":
      return wrap(ns.singularity.connect(a.server), "connect " + a.server);

    case "backdoor":
      return await execBackdoor(ns, a.server);

    case "work_company": {
      const company = resolveCompanyName(ns, a.company);
      if (!company) return fail("unknown company: " + a.company);
      return wrap(ns.singularity.workForCompany(company, false), "work " + company);
    }

    case "work_faction": {
      const type = normalize(ns, "factionWork", a.type || "hacking");
      return wrap(ns.singularity.workForFaction(a.faction, type, false),
                  "faction " + a.faction + " " + type);
    }

    case "study": {
      const course = normalize(ns, "universityClass", a.course || "Algorithms");
      const u = a.university || "Rothman University";
      return wrap(ns.singularity.universityCourse(u, course, false), "study " + course);
    }

    case "gym": {
      const stat = normalize(ns, "gym", a.stat || "strength");
      const gym = a.gym || "Powerhouse Gym";
      return wrap(ns.singularity.gymWorkout(gym, stat, false), "gym " + stat);
    }

    case "commit_crime": {
      const crime = normalize(ns, "crime", a.crime || "Mug");
      return wrap(ns.singularity.commitCrime(crime, false) !== "", "crime " + crime);
    }

    case "buy_program":
      return buyProgram(ns, a.program);

    case "buy_augmentation":
      return wrap(ns.singularity.purchaseAugmentation(a.faction, a.aug),
                  "bought aug " + a.aug);

    case "join_faction":
      return wrap(ns.singularity.joinFaction(a.faction), "joined " + a.faction);

    case "donate_faction":
      return wrap(ns.singularity.donateToFaction(a.faction, Number(a.amount || 0)),
                  "donated " + a.amount);

    case "install_augmentations":
      return installAugmentations(ns);

    case "soft_reset":
      ns.singularity.softReset("scb.js");
      return ok("soft reset triggered");

    default:
      return fail("singularity: unknown action " + a.action);
  }
}

async function execBackdoor(ns, server) {
  if (!server || !serverExists(ns, server)) return fail("invalid backdoor server: " + server);
  const path = findPath(ns, "home", server);
  if (!path.length) return fail("no path to " + server);

  ns.singularity.connect("home");
  for (const hop of path) ns.singularity.connect(hop);
  await ns.singularity.installBackdoor();
  ns.singularity.connect("home");
  return ok("backdoor " + server);
}

function buyProgram(ns, program) {
  if (!program) return fail("missing program");
  if (!ns.hasTorRouter()) {
    if (ns.getServerMoneyAvailable("home") < 200_000) {
      return fail("no TOR and insufficient cash");
    }
    ns.singularity.purchaseTor();
  }
  if (ns.fileExists(program, "home")) return ok(program + " already owned");
  return wrap(ns.singularity.purchaseProgram(program), "buy " + program);
}

function installAugmentations(ns) {
  const queued = (ns.singularity.getOwnedAugmentations(true) || []).length;
  const owned  = (ns.singularity.getOwnedAugmentations(false) || []).length;
  const pending = queued - owned;
  if (pending < 5) return fail("only " + pending + " pending augs, min 5");
  ns.singularity.installAugmentations("scb.js");
  return ok("installing augmentations");
}

function serverExists(ns, server) {
  try { ns.getServer(server); return true; } catch { return false; }
}

function findPath(ns, source, target) {
  const visited = new Set([source]);
  const queue = [[source, []]];
  while (queue.length) {
    const [cur, path] = queue.shift();
    for (const next of ns.scan(cur)) {
      if (visited.has(next)) continue;
      visited.add(next);
      const newPath = [...path, next];
      if (next === target) return newPath;
      queue.push([next, newPath]);
    }
  }
  return [];
}

function normalize(ns, kind, value) {
  const map = {
    crime:           ns.enums?.CrimeType,
    factionWork:     ns.enums?.FactionWorkType,
    universityClass: ns.enums?.UniversityClassType,
    gym:             ns.enums?.GymType
  };
  const e = map[kind];
  if (!e) return value;
  const target = keyFold(value);
  for (const v of Object.values(e)) if (keyFold(v) === target) return v;
  return value;
}
function keyFold(v) { return String(v ?? "").toLowerCase().replace(/[\s_\-]/g, ""); }

function resolveCompanyName(ns, raw) {
  if (!raw) return null;
  const wanted = keyFold(raw);
  let names = [];
  try {
    const e = ns.enums?.CompanyName;
    if (e) names = Object.values(e);
  } catch (_) {}
  for (const n of names) if (keyFold(n) === wanted) return n;
  const aliases = {
    cybersec: "CyberSec", maxhardware: "Max Hardware Store", nsa: "NSA",
    ecorp: "ECorp", megacorp: "MegaCorp", foursigma: "Four Sigma",
    fulcrumtech: "Fulcrum Technologies", bladeind: "Blade Industries",
    bladeindustries: "Blade Industries", omnitek: "OmniTek Incorporated",
    kuaigong: "KuaiGong International", clarketech: "Clarke Incorporated",
    aevumpolice: "Aevum Police Headquarters", bachman: "Bachman & Associates"
  };
  return aliases[wanted] || null;
}

function wrap(success, result) { return { success: !!success, result: String(result) }; }
function ok(result)   { return { success: true,  result: String(result) }; }
function fail(result) { return { success: false, result: String(result) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
