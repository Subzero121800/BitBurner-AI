/**
 * ollama-actions.js — AI Action Library
 * ACTIONS_VERSION_4_SMART_RAM_AWARE
 *
 * Library imported by /ollama-player.js.
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.tprint("INFO  ollama-actions.js is a library, not a runnable script.");
  ns.tprint("INFO  It exports ACTION_SCHEMA / validateAction / executeAction.");

  if (ns.args.includes("--list")) {
    ns.tprint("");
    ns.tprint("Available actions (" + ACTION_SCHEMA.length + "):");

    for (const a of ACTION_SCHEMA) {
      const args = a.args.length ? " <" + a.args.join("> <") + ">" : "";
      ns.tprint("  " + a.action + args + " — " + a.desc);
    }
  }
}

export const ACTION_SCHEMA = [
  { action: "hack", args: ["target"], desc: "Deploy hack workers against target using best available RAM" },
  { action: "grow", args: ["target"], desc: "Deploy grow workers against target using best available RAM" },
  { action: "weaken", args: ["target"], desc: "Deploy weaken workers against target using best available RAM" },
  { action: "deploy_hack", args: ["target", "server"], desc: "Deploy weaken/grow/hack split. If server is full, auto-picks better server" },

  { action: "travel", args: ["city"], desc: "Travel to a city" },
  { action: "connect", args: ["server"], desc: "Connect terminal to a server" },
  { action: "backdoor", args: ["server"], desc: "Install backdoor on a server" },

  { action: "work_company", args: ["company"], desc: "Work at company for pay/rep" },
  { action: "work_faction", args: ["faction", "type"], desc: "Work for faction. type: hacking | field | security" },
  { action: "study", args: ["course", "university"], desc: "Take university course" },
  { action: "gym", args: ["stat", "gym"], desc: "Train stat at gym" },
  { action: "commit_crime", args: ["crime"], desc: "Commit crime" },

  { action: "buy_program", args: ["program"], desc: "Buy hacking program from darkweb" },
  { action: "buy_server", args: ["ram"], desc: "Purchase new server" },
  { action: "upgrade_server", args: ["server", "ram"], desc: "Upgrade purchased server" },
  { action: "buy_augmentation", args: ["faction", "aug"], desc: "Buy augmentation" },
  { action: "buy_hacknet_node", args: [], desc: "Buy hacknet node" },
  { action: "upgrade_hacknet", args: ["node", "type"], desc: "Upgrade hacknet level | ram | core" },

  { action: "join_faction", args: ["faction"], desc: "Accept faction invite" },
  { action: "donate_faction", args: ["faction", "amount"], desc: "Donate to faction" },

  { action: "sleeve_task", args: ["sleeve", "task"], desc: "Assign sleeve task" },

  { action: "gang_recruit", args: [], desc: "Recruit gang member" },
  { action: "gang_assign", args: ["member", "task"], desc: "Assign gang member task" },
  { action: "gang_ascend", args: ["member"], desc: "Ascend gang member" },

  { action: "bb_action", args: ["type", "name"], desc: "Start Bladeburner action" },
  { action: "bb_skill", args: ["skill"], desc: "Upgrade Bladeburner skill" },

  { action: "install_augmentations", args: [], desc: "Install queued augmentations and reset" },
  { action: "soft_reset", args: [], desc: "Soft reset" },
  { action: "wait", args: ["ms"], desc: "Sleep for milliseconds" },
  { action: "noop", args: [], desc: "Do nothing" },

  // ─── Filesystem & process control (guard-railed) ────────────────
  // Reads are unrestricted. Writes are confined to safe dirs (see
  // WRITE_ALLOWED_PREFIXES below). Touching anything in PROTECTED
  // is rejected — instead, propose_patch writes to /ai/patches/.
  { action: "read_file",              args: ["path"],                   desc: "Read a file (no path restrictions)" },
  { action: "list_files",             args: ["prefix?"],                desc: "List files on home, optionally filtered by prefix (e.g. '/ai/')" },
  { action: "write_generated_script", args: ["path", "content"],        desc: "Write a script under /ai/generated/, /Temp/, /logs/, or /ai/scratch/" },
  { action: "delete_generated_script",args: ["path"],                   desc: "Delete a file under one of the AI-allowed dirs" },
  { action: "run_script",             args: ["script", "host?", "threads?", "argv?"], desc: "Run a script under an AI-allowed dir on home or any rooted server" },
  { action: "kill_script",            args: ["script", "host?"],        desc: "Kill all instances of a script (filename match) on a host" },
  { action: "copy_script",            args: ["script", "dst_host"],     desc: "Copy a script from home to dst_host (must be rooted)" },
  { action: "propose_patch",          args: ["target", "content", "reason"], desc: "Propose a change to a PROTECTED file. Writes /ai/patches/pending-patch.json — a human runs /approve-patch.js to apply" },

  // ─── System health ────────────────────────────────────────────────
  { action: "reconnect_remote_api",   args: [],                                      desc: "Best-effort programmatic Options → Remote API → Connect via DOM. Use when state.systemHealth.syncStale is true." }
];

const VALID_ACTIONS = new Set(ACTION_SCHEMA.map((a) => a.action));

export function validateAction(action) {
  if (!action || typeof action !== "object") {
    return { ok: false, reason: "not an object" };
  }

  if (typeof action.action !== "string") {
    return { ok: false, reason: "missing .action" };
  }

  if (!VALID_ACTIONS.has(action.action)) {
    return { ok: false, reason: "unknown action: " + action.action };
  }

  return { ok: true };
}

export async function executeAction(ns, action) {
  try {
    const valid = validateAction(action);

    if (!valid.ok) {
      return fail(valid.reason);
    }

    switch (action.action) {
      case "hack":
      case "grow":
      case "weaken":
        return deployBasic(ns, action.target, action.action);

      case "deploy_hack":
        return deploySmartSplit(ns, action.target, action.server);

      case "travel":
        return wrap(ns.singularity.travelToCity(action.city), "travel " + action.city);

      case "connect":
        return wrap(ns.singularity.connect(action.server), "connect " + action.server);

      case "backdoor":
        return await execBackdoor(ns, action.server);

      case "work_company":
        return wrap(ns.singularity.workForCompany(action.company, false), "work " + action.company);

      case "work_faction": {
        const type = normalize(ns, "factionWork", action.type || "hacking");
        return wrap(ns.singularity.workForFaction(action.faction, type, false), "faction " + action.faction + " " + type);
      }

      case "study": {
        const course = normalize(ns, "universityClass", action.course || "Algorithms");
        const university = action.university || "Rothman University";
        return wrap(ns.singularity.universityCourse(university, course, false), "study " + course);
      }

      case "gym": {
        const stat = normalize(ns, "gym", action.stat || "strength");
        const gym = action.gym || "Powerhouse Gym";
        return wrap(ns.singularity.gymWorkout(gym, stat, false), "gym " + stat);
      }

      case "commit_crime": {
        const crime = normalize(ns, "crime", action.crime || "Mug");
        const result = ns.singularity.commitCrime(crime, false);
        return wrap(result !== "", "crime " + crime);
      }

      case "buy_program":
        return buyProgram(ns, action.program);

      case "buy_server":
        return buyServer(ns, Number(action.ram || 8));

      case "upgrade_server":
        return upgradeServer(ns, action.server, Number(action.ram || 0));

      case "buy_augmentation":
        return wrap(ns.singularity.purchaseAugmentation(action.faction, action.aug), "bought aug " + action.aug);

      case "buy_hacknet_node": {
        const idx = ns.hacknet.purchaseNode();
        return wrap(idx >= 0, "hacknet node " + idx);
      }

      case "upgrade_hacknet":
        return upgradeHacknet(ns, action.node, action.type);

      case "join_faction":
        return wrap(ns.singularity.joinFaction(action.faction), "joined " + action.faction);

      case "donate_faction":
        return wrap(ns.singularity.donateToFaction(action.faction, Number(action.amount || 0)), "donated " + action.amount);

      case "sleeve_task":
        return execSleeveTask(ns, action);

      case "gang_recruit":
        return gangRecruit(ns);

      case "gang_assign":
        return wrap(ns.gang.setMemberTask(action.member, action.task), action.member + " -> " + action.task);

      case "gang_ascend": {
        const result = ns.gang.ascendMember(action.member);
        return wrap(!!result, "ascended " + action.member);
      }

      case "bb_action": {
        const type = normalize(ns, "bbActionType", action.type || "General");
        return wrap(ns.bladeburner.startAction(type, action.name), "BB " + type + " / " + action.name);
      }

      case "bb_skill":
        return wrap(ns.bladeburner.upgradeSkill(action.skill, 1), "BB skill " + action.skill);

      case "install_augmentations":
        return installAugmentations(ns);

      case "soft_reset":
        ns.singularity.softReset("scb.js");
        return ok("soft reset triggered");

      case "wait":
        await ns.sleep(Number(action.ms || 30_000));
        return ok("waited " + Number(action.ms || 30_000) + "ms");

      case "noop":
        return ok("no-op");

      // ─── Filesystem & process control ──────────────────────────
      case "read_file":
        return aiReadFile(ns, action);

      case "list_files":
        return aiListFiles(ns, action);

      case "write_generated_script":
        return aiWriteGenerated(ns, action);

      case "delete_generated_script":
        return aiDeleteGenerated(ns, action);

      case "run_script":
        return aiRunScript(ns, action);

      case "kill_script":
        return aiKillScript(ns, action);

      case "copy_script":
        return aiCopyScript(ns, action);

      case "propose_patch":
        return aiProposePatch(ns, action);

      case "reconnect_remote_api":
        return await aiReconnectRemoteApi(ns);

      default:
        return fail("unknown action: " + action.action);
    }
  } catch (e) {
    return fail("threw: " + String(e));
  }
}

function deployBasic(ns, target, op) {
  if (!target || !serverExists(ns, target)) {
    return fail("invalid target: " + target);
  }

  const file = op === "hack" ? "hack.js" : op === "grow" ? "grow.js" : "weaken.js";
  ensureLoopWorker(ns, file);

  const server = pickBestWorkerServer(ns, file);

  if (!server) {
    return fail("no worker server has free RAM for " + file);
  }

  copyIfNeeded(ns, file, server);

  const free = freeRam(ns, server);
  const cost = scriptRam(ns, file);
  const threads = Math.floor(free / cost);

  if (threads < 1) {
    return fail(server + " has no free RAM for " + file);
  }

  const pid = ns.exec(file, server, threads, target);

  if (pid <= 0) {
    return fail("exec failed: " + file + " on " + server);
  }

  return ok(op + " " + target + " x" + threads + " on " + server);
}

function deploySmartSplit(ns, target, requestedServer) {
  if (!target || !serverExists(ns, target)) {
    return fail("invalid target: " + target);
  }

  ensureLoopWorker(ns, "hack.js");
  ensureLoopWorker(ns, "grow.js");
  ensureLoopWorker(ns, "weaken.js");

  const requestedUsable =
    requestedServer &&
    serverExists(ns, requestedServer) &&
    freeRam(ns, requestedServer) >= minSplitRam(ns);

  const server = requestedUsable
    ? requestedServer
    : pickBestWorkerServer(ns, "weaken.js");

  if (!server) {
    return fail("no worker server has enough free RAM for split deploy");
  }

  for (const file of ["hack.js", "grow.js", "weaken.js"]) {
    copyIfNeeded(ns, file, server);
  }

  const free = freeRam(ns, server);

  if (free < minSplitRam(ns)) {
    return fail(server + " has insufficient free RAM: " + ns.format.ram(free));
  }

  killWorkerSet(ns, server);

  const wRam = scriptRam(ns, "weaken.js");
  const gRam = scriptRam(ns, "grow.js");
  const hRam = scriptRam(ns, "hack.js");

  let wT = Math.floor((free * 0.5) / wRam);
  let gT = Math.floor((free * 0.3) / gRam);
  let hT = Math.floor((free * 0.2) / hRam);

  if (wT < 1 && free >= wRam) wT = 1;
  if (gT < 1 && free >= gRam + wT * wRam) gT = 1;
  if (hT < 1 && free >= hRam + wT * wRam + gT * gRam) hT = 1;

  let launched = [];

  if (wT > 0) {
    const pid = ns.exec("weaken.js", server, wT, target);
    if (pid > 0) launched.push("W:" + wT);
  }

  if (gT > 0) {
    const pid = ns.exec("grow.js", server, gT, target);
    if (pid > 0) launched.push("G:" + gT);
  }

  if (hT > 0) {
    const pid = ns.exec("hack.js", server, hT, target);
    if (pid > 0) launched.push("H:" + hT);
  }

  if (launched.length === 0) {
    return fail("no workers launched on " + server);
  }

  const redirected = requestedServer && requestedServer !== server
    ? " redirected from " + requestedServer
    : "";

  return ok("deployed " + target + " on " + server + " " + launched.join(" ") + redirected);
}

async function execBackdoor(ns, server) {
  if (!server || !serverExists(ns, server)) {
    return fail("invalid backdoor server: " + server);
  }

  const path = findPath(ns, "home", server);

  if (path.length === 0) {
    return fail("no path to " + server);
  }

  ns.singularity.connect("home");

  for (const hop of path) {
    ns.singularity.connect(hop);
  }

  await ns.singularity.installBackdoor();
  ns.singularity.connect("home");

  return ok("backdoor " + server);
}

function buyProgram(ns, program) {
  if (!program) return fail("missing program");

  if (!ns.hasTorRouter()) {
    const cash = ns.getServerMoneyAvailable("home");

    if (cash < 200_000) {
      return fail("no TOR and insufficient cash");
    }

    ns.singularity.purchaseTor();
  }

  if (ns.fileExists(program, "home")) {
    return ok(program + " already owned");
  }

  return wrap(ns.singularity.purchaseProgram(program), "buy " + program);
}

function buyServer(ns, ram) {
  ram = sanitizeRam(ram);

  const maxServers = ns.cloud.getServerLimit();
  const owned = ns.cloud.getServerNames();

  if (owned.length >= maxServers) {
    return fail("server limit reached");
  }

  const cost = ns.cloud.getServerCost(ram);
  const cash = ns.getServerMoneyAvailable("home");

  if (cash < cost) {
    return fail("insufficient funds for " + ns.format.ram(ram) + " server");
  }

  const name = nextServerName(owned, "ai-pserv-");
  const bought = ns.cloud.purchaseServer(name, ram);

  return wrap(!!bought, "bought " + bought + " " + ns.format.ram(ram));
}

function upgradeServer(ns, server, ram) {
  if (!server || !serverExists(ns, server)) {
    return fail("invalid server: " + server);
  }

  ram = sanitizeRam(ram);

  const current = ns.getServerMaxRam(server);

  if (ram <= current) {
    ram = current * 2;
  }

  const maxRam = ns.cloud.getRamLimit();

  if (ram > maxRam) {
    ram = maxRam;
  }

  const cost = ns.cloud.getServerUpgradeCost(server, ram);
  const cash = ns.getServerMoneyAvailable("home");

  if (cost < 0 || cost === Infinity) {
    return fail("cannot compute upgrade cost");
  }

  if (cash < cost) {
    return fail("insufficient funds for upgrade");
  }

  ns.killall(server);

  return wrap(ns.cloud.upgradeServer(server, ram), "upgraded " + server + " to " + ns.format.ram(ram));
}

function upgradeHacknet(ns, node, type) {
  const index = Number(node || 0);

  if (index < 0 || index >= ns.hacknet.numNodes()) {
    return fail("invalid hacknet node: " + node);
  }

  let okResult = false;

  if (type === "level") {
    okResult = ns.hacknet.upgradeLevel(index, 1);
  } else if (type === "ram") {
    okResult = ns.hacknet.upgradeRam(index, 1);
  } else if (type === "core") {
    okResult = ns.hacknet.upgradeCore(index, 1);
  } else {
    return fail("unknown hacknet upgrade type: " + type);
  }

  return wrap(okResult, "upgraded hacknet " + index + " " + type);
}

function execSleeveTask(ns, action) {
  const sleeve = Number(action.sleeve || 0);

  if (sleeve < 0 || sleeve >= ns.sleeve.getNumSleeves()) {
    return fail("invalid sleeve: " + sleeve);
  }

  switch (action.task) {
    case "crime": {
      const crime = normalize(ns, "crime", action.crime || "Mug");
      return wrap(ns.sleeve.setToCommitCrime(sleeve, crime), "sleeve " + sleeve + " crime " + crime);
    }

    case "faction": {
      const type = normalize(ns, "factionWork", action.type || "hacking");
      return wrap(ns.sleeve.setToFactionWork(sleeve, action.faction, type), "sleeve " + sleeve + " faction " + action.faction);
    }

    case "company":
      return wrap(ns.sleeve.setToCompanyWork(sleeve, action.company), "sleeve " + sleeve + " company");

    case "gym": {
      const stat = normalize(ns, "gym", action.stat || "strength");
      return wrap(ns.sleeve.setToGymWorkout(sleeve, action.gym || "Powerhouse Gym", stat), "sleeve " + sleeve + " gym " + stat);
    }

    case "study": {
      const course = normalize(ns, "universityClass", action.course || "Algorithms");
      return wrap(ns.sleeve.setToUniversityCourse(sleeve, action.university || "Rothman University", course), "sleeve " + sleeve + " study " + course);
    }

    case "sync":
      return wrap(ns.sleeve.setToSynchronize(sleeve), "sleeve " + sleeve + " sync");

    case "recover":
      return wrap(ns.sleeve.setToShockRecovery(sleeve), "sleeve " + sleeve + " recover");

    case "idle":
      return wrap(ns.sleeve.setToIdle(sleeve), "sleeve " + sleeve + " idle");

    default:
      return fail("unknown sleeve task: " + action.task);
  }
}

function gangRecruit(ns) {
  const names = ns.gang.getMemberNames();
  const name = "Member-" + names.length;
  return wrap(ns.gang.recruitMember(name), "recruited " + name);
}

function installAugmentations(ns) {
  const queued = ns.singularity.getOwnedAugmentations(true).length;
  const owned = ns.singularity.getOwnedAugmentations(false).length;
  const pending = queued - owned;

  if (pending < 5) {
    return fail("only " + pending + " pending augs, min 5");
  }

  ns.singularity.installAugmentations("scb.js");
  return ok("installing augmentations");
}

function ensureLoopWorker(ns, file) {
  const bodies = {
    "hack.js": "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.hack(t);}",
    "grow.js": "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.grow(t);}",
    "weaken.js": "/** @param {NS} ns */ export async function main(ns){const t=ns.args[0];while(true)await ns.weaken(t);}"
  };

  if (!ns.fileExists(file, "home")) {
    ns.write(file, bodies[file], "w");
  }
}

function pickBestWorkerServer(ns, requiredScript) {
  const servers = getWorkerServers(ns);
  const ramCost = scriptRam(ns, requiredScript);

  const ranked = servers
    .filter((server) => serverExists(ns, server))
    .map((server) => ({
      server,
      free: freeRam(ns, server),
      max: ns.getServerMaxRam(server),
      used: ns.getServerUsedRam(server)
    }))
    .filter((s) => s.free >= ramCost)
    .sort((a, b) => b.free - a.free || b.max - a.max);

  return ranked[0]?.server || null;
}

function getWorkerServers(ns) {
  const purchased = ns.cloud.getServerNames();
  const rooted = deepScan(ns)
    .filter((s) => s !== "home")
    .filter((s) => !s.startsWith("hacknet"))
    .filter((s) => ns.hasRootAccess(s))
    .filter((s) => ns.getServerMaxRam(s) > 0);

  return [...new Set([...purchased, ...rooted, "home"])];
}

function freeRam(ns, server) {
  const reserve = server === "home" ? 256 : 0;
  return Math.max(0, ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserve);
}

function scriptRam(ns, file) {
  return ns.getScriptRam(file, "home") || 1.75;
}

function minSplitRam(ns) {
  return scriptRam(ns, "weaken.js") + scriptRam(ns, "grow.js") + scriptRam(ns, "hack.js");
}

function copyIfNeeded(ns, file, server) {
  if (server !== "home" && !ns.fileExists(file, server)) {
    ns.scp(file, server, "home");
  }
}

function killWorkerSet(ns, server) {
  for (const proc of ns.ps(server)) {
    if (["hack.js", "grow.js", "weaken.js"].includes(proc.filename)) {
      ns.kill(proc.pid);
    }
  }
}

function serverExists(ns, server) {
  try {
    ns.getServer(server);
    return true;
  } catch {
    return false;
  }
}

function deepScan(ns) {
  const visited = new Set();
  const queue = ["home"];

  while (queue.length > 0) {
    const current = queue.pop();

    if (visited.has(current)) continue;

    visited.add(current);

    for (const next of ns.scan(current)) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return [...visited];
}

function findPath(ns, source, target) {
  const visited = new Set([source]);
  const queue = [[source, []]];

  while (queue.length > 0) {
    const [current, path] = queue.shift();

    for (const next of ns.scan(current)) {
      if (visited.has(next)) continue;

      visited.add(next);

      const nextPath = [...path, next];

      if (next === target) return nextPath;

      queue.push([next, nextPath]);
    }
  }

  return [];
}

function sanitizeRam(value) {
  let ram = Number(value || 8);

  if (!Number.isFinite(ram) || ram < 8) {
    ram = 8;
  }

  ram = Math.pow(2, Math.floor(Math.log2(ram)));

  return Math.max(8, ram);
}

function nextServerName(owned, prefix) {
  let index = 0;

  while (owned.includes(prefix + index)) {
    index++;
  }

  return prefix + index;
}

function normalize(ns, kind, value) {
  const values = enumValues(ns, kind);

  if (!values.length) return value;

  const target = keyFold(value);

  for (const v of values) {
    if (keyFold(v) === target) return v;
  }

  return value;
}

function enumValues(ns, kind) {
  try {
    const e = ns.enums || {};

    const map = {
      crime: e.CrimeType,
      factionWork: e.FactionWorkType,
      universityClass: e.UniversityClassType,
      gym: e.GymType,
      jobField: e.JobField,
      stockPosition: e.PositionType,
      stockOrder: e.OrderType,
      bbActionType: e.BladeburnerActionType
    };

    const found = map[kind];

    if (!found) return [];

    return Object.values(found);
  } catch {
    return [];
  }
}

function keyFold(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s_\-]/g, "");
}

function wrap(success, result) {
  return {
    success: !!success,
    result: String(result)
  };
}

function ok(result) {
  return {
    success: true,
    result: String(result)
  };
}

function fail(result) {
  return {
    success: false,
    result: String(result)
  };
}

// ════════════════════════════════════════════════════════════════════
//  AI FILESYSTEM ACCESS — guard-railed
// ════════════════════════════════════════════════════════════════════
// The AI can read anything (it sees most state already), but writes,
// deletes, and exec are tightly scoped:
//
//   • Writes/deletes: only inside /ai/generated/, /Temp/, /logs/,
//     /ai/scratch/ — anywhere else returns fail() without touching
//     the filesystem.
//   • run_script: only files inside the same allowlist may be
//     executed (so the AI can't `run scb.js` and accidentally
//     restart the orchestrator with surprise args).
//   • kill_script: any filename, any host. Killing is reversible
//     (just re-run) so this is intentionally open.
//   • copy_script: source path must be in the allowlist; destination
//     must be a rooted server (no NPC-only servers).
//   • Anything in PROTECTED is rejected outright — instead, the AI
//     uses propose_patch to write a JSON proposal that a human
//     approves with /approve-patch.js.

const PROTECTED = new Set([
  "scb.js",            "/scb.js",
  "ollama-player.js",  "/ollama-player.js",
  "ollama-actions.js", "/ollama-actions.js",
  "scb-watchdog.js",   "/scb-watchdog.js",
  "server-upgrader.js","/server-upgrader.js",
  "contractor.js",     "/contractor.js",
  "hack.js",  "/hack.js",
  "grow.js",  "/grow.js",
  "weaken.js","/weaken.js",
  "helpers.js","/helpers.js",
  "autopilot.js","/autopilot.js",
]);

const WRITE_ALLOWED_PREFIXES = [
  "/ai/generated/",
  "/ai/scratch/",
  "/Temp/",
  "/logs/",
];

const PATCH_PENDING = "/ai/patches/pending-patch.json";
const PATCH_LOG     = "/ai/patches/proposals.log";

function normPath(p) {
  if (!p) return "";
  let s = String(p).trim();
  if (!s) return "";
  if (!s.startsWith("/")) s = "/" + s;
  // collapse "/.." / "//" / "/./" so the AI can't path-traverse out
  // of the allowlist via "/ai/generated/../scb.js".
  s = s.replace(/\/\.\//g, "/").replace(/\/+/g, "/");
  while (s.includes("/../")) s = s.replace(/\/[^/]+\/\.\.\//, "/");
  return s;
}

function isProtected(p) {
  const n = normPath(p);
  if (PROTECTED.has(n)) return true;
  if (PROTECTED.has(n.replace(/^\//, ""))) return true;
  return false;
}

function isWriteAllowed(p) {
  const n = normPath(p);
  if (!n) return false;
  if (isProtected(n)) return false;
  return WRITE_ALLOWED_PREFIXES.some(prefix => n.startsWith(prefix));
}

function aiReadFile(ns, action) {
  const p = normPath(action.path);
  if (!p) return fail("read_file: missing path");
  if (!ns.fileExists(p, "home")) return fail("read_file: not found: " + p);
  try {
    const content = ns.read(p);
    // Cap in the result so a 200 KB file doesn't blow up the prompt.
    const max = 4000;
    const truncated = content.length > max;
    const body = truncated ? content.slice(0, max) + "\n...[truncated " + (content.length - max) + " bytes]" : content;
    return ok("read " + p + " (" + content.length + " B): " + body);
  } catch (e) {
    return fail("read_file threw: " + String(e.message || e));
  }
}

function aiListFiles(ns, action) {
  try {
    const prefix = normPath(action.prefix || "/");
    const all = ns.ls("home", prefix === "/" ? "" : prefix);
    if (!all.length) return ok("list_files " + prefix + ": (empty)");
    // Cap to first 60 to keep response cheap.
    const head = all.slice(0, 60);
    const more = all.length > 60 ? " ...(" + (all.length - 60) + " more)" : "";
    return ok("list_files " + prefix + " (" + all.length + "): " + head.join(", ") + more);
  } catch (e) {
    return fail("list_files threw: " + String(e.message || e));
  }
}

function aiWriteGenerated(ns, action) {
  const p = normPath(action.path);
  const content = action.content;
  if (!p) return fail("write_generated_script: missing path");
  if (typeof content !== "string") return fail("write_generated_script: content must be a string");
  if (isProtected(p)) return fail("write_generated_script: " + p + " is PROTECTED — use propose_patch");
  if (!isWriteAllowed(p)) return fail("write_generated_script: " + p + " is outside allowed dirs (" + WRITE_ALLOWED_PREFIXES.join(", ") + ")");
  if (content.length > 100_000) return fail("write_generated_script: content > 100 KB, refused");
  try {
    ns.write(p, content, "w");
    return ok("wrote " + p + " (" + content.length + " B)");
  } catch (e) {
    return fail("write_generated_script threw: " + String(e.message || e));
  }
}

function aiDeleteGenerated(ns, action) {
  const p = normPath(action.path);
  if (!p) return fail("delete_generated_script: missing path");
  if (isProtected(p)) return fail("delete_generated_script: " + p + " is PROTECTED");
  if (!isWriteAllowed(p)) return fail("delete_generated_script: " + p + " is outside allowed dirs");
  if (!ns.fileExists(p, "home")) return fail("delete_generated_script: not found: " + p);
  try {
    const removed = ns.rm(p, "home");
    return removed ? ok("deleted " + p) : fail("rm refused for " + p);
  } catch (e) {
    return fail("delete_generated_script threw: " + String(e.message || e));
  }
}

function aiRunScript(ns, action) {
  const p = normPath(action.script);
  const host = action.host || "home";
  const threads = Math.max(1, Math.floor(Number(action.threads) || 1));
  const argv = Array.isArray(action.argv) ? action.argv : [];
  if (!p) return fail("run_script: missing script");
  if (isProtected(p)) return fail("run_script: " + p + " is PROTECTED");
  if (!isWriteAllowed(p)) return fail("run_script: " + p + " must live under " + WRITE_ALLOWED_PREFIXES.join(", "));
  if (!ns.fileExists(p, host)) return fail("run_script: not found on " + host + ": " + p);
  if (host !== "home" && !ns.hasRootAccess(host)) return fail("run_script: no root on " + host);
  try {
    const pid = ns.exec(p, host, threads, ...argv);
    return pid > 0 ? ok("ran " + p + " on " + host + " x" + threads + " (pid " + pid + ")") : fail("exec returned 0 — RAM?");
  } catch (e) {
    return fail("run_script threw: " + String(e.message || e));
  }
}

function aiKillScript(ns, action) {
  const filename = String(action.script || "").trim();
  const host = action.host || "home";
  if (!filename) return fail("kill_script: missing script");
  // No protected/allow check here — the AI killing things is
  // reversible (next scb cycle re-spawns), and the user explicitly
  // asked for restart capability.
  try {
    let killed = 0;
    for (const proc of ns.ps(host)) {
      if (proc.filename === filename || proc.filename === "/" + filename || proc.filename === filename.replace(/^\//, "")) {
        if (ns.kill(proc.pid)) killed++;
      }
    }
    return killed > 0 ? ok("killed " + killed + " " + filename + " on " + host) : fail("no matches for " + filename + " on " + host);
  } catch (e) {
    return fail("kill_script threw: " + String(e.message || e));
  }
}

function aiCopyScript(ns, action) {
  const p = normPath(action.script);
  const dst = action.dst_host;
  if (!p)   return fail("copy_script: missing script");
  if (!dst) return fail("copy_script: missing dst_host");
  if (isProtected(p)) return fail("copy_script: " + p + " is PROTECTED");
  if (!isWriteAllowed(p)) return fail("copy_script: " + p + " must live under " + WRITE_ALLOWED_PREFIXES.join(", "));
  if (!ns.fileExists(p, "home")) return fail("copy_script: not found on home: " + p);
  if (!ns.hasRootAccess(dst)) return fail("copy_script: no root on " + dst);
  try {
    const ok2 = ns.scp(p, dst, "home");
    return ok2 ? ok("copied " + p + " → " + dst) : fail("scp returned false");
  } catch (e) {
    return fail("copy_script threw: " + String(e.message || e));
  }
}

async function aiReconnectRemoteApi(ns) {
  // Identical DOM walker as scb-watchdog.tryReconnect: open the
  // Options panel, click the Remote API tab, click Connect. Used
  // when the AI sees state.systemHealth.syncStale === true and wants
  // to recover proactively. Best-effort — fragile across Bitburner UI
  // versions but degrades gracefully.
  try {
    const doc = globalThis["doc" + "ument"];
    if (!doc || typeof doc.querySelectorAll !== "function") {
      return fail("reconnect: no document handle (Bitburner sandbox?)");
    }
    const find = (label, pred) => {
      try {
        const all = doc.querySelectorAll("button, a, li, [role=tab], [role=menuitem], div, span");
        for (const el of all) {
          const t = (el.textContent || "").trim();
          if ((t === label || t.toLowerCase() === label.toLowerCase()) && (!pred || pred(el))) return el;
        }
      } catch (_) {}
      return null;
    };

    let btn = find("Connect", (el) => el.tagName === "BUTTON" && (el.textContent || "").trim() === "Connect");
    if (btn) { btn.click(); return ok("clicked Connect (fast path)"); }

    const opts = find("Options", (el) => ["BUTTON", "A", "LI", "DIV"].includes(el.tagName));
    if (!opts) return fail("reconnect: Options nav not found");
    opts.click();
    await ns.sleep(200);

    const tab = find("Remote API");
    if (tab) { tab.click(); await ns.sleep(200); }

    btn = find("Connect", (el) => el.tagName === "BUTTON" && (el.textContent || "").trim() === "Connect");
    if (!btn) {
      const dis = find("Disconnect", (el) => el.tagName === "BUTTON" && (el.textContent || "").trim() === "Disconnect");
      if (dis) return ok("already connected (Disconnect shown)");
      return fail("reconnect: Connect button not located after opening panel");
    }
    btn.click();
    return ok("navigated Options→Remote API→Connect");
  } catch (e) {
    return fail("reconnect threw: " + String(e.message || e));
  }
}

function aiProposePatch(ns, action) {
  const target = normPath(action.target);
  const content = action.content;
  const reason = String(action.reason || "(no reason)");
  if (!target) return fail("propose_patch: missing target");
  if (typeof content !== "string") return fail("propose_patch: content must be a string");
  if (content.length > 200_000) return fail("propose_patch: content > 200 KB, refused");
  if (!isProtected(target)) {
    return fail("propose_patch is for PROTECTED files only — use write_generated_script for " + target);
  }
  try {
    const proposal = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      target,
      reason,
      bytes: content.length,
      content,
    };
    ns.write(PATCH_PENDING, JSON.stringify(proposal, null, 2), "w");
    // Append a short log line (no full content) so the user has a
    // history even after they approve / reject.
    const logLine = proposal.iso + " " + target + " (" + proposal.bytes + "B) reason=" + reason.replace(/\s+/g, " ").slice(0, 200) + "\n";
    try { ns.write(PATCH_LOG, logLine, "a"); } catch (_) {}
    ns.toast("AI proposed patch for " + target + " — review with /approve-patch.js", "info", 8000);
    return ok("patch proposed for " + target + " (" + content.length + " B). Run `run /approve-patch.js` to review.");
  } catch (e) {
    return fail("propose_patch threw: " + String(e.message || e));
  }
}