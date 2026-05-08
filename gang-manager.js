/**
 * gang-manager.js — slim orchestrator (v4)
 *
 * GANG_MANAGER_VERSION_4
 *
 * v4 splits the previous monolithic v3 manager (~32 GB resident) into:
 *   - /helpers/gang-snapshot.js  (transient ~22 GB)
 *   - /helpers/gang-execute.js   (transient ~10 GB)
 *   - gang-manager.js (this file, ~3 GB resident)
 *
 * Decision logic carried over from v3 (rolling ascensions, two-tier
 * equipment buying, per-member task scoring, vigilante overflow,
 * territory-warfare auto-toggle). The orchestrator now only computes
 * the plan; the helpers do every gang-namespace call.
 */

const POLL_MS              = 4_000;
const MAX_MEMBERS          = 12;
const ASCEND_BASE          = 1.05;
const ASCEND_SPACING       = 0.05;
const WARFARE_POWER_RATIO  = 1.5;
const WANTED_RATIO_HIGH    = 0.10;
const VIGILANTE_FRACTION   = 0.40;
const TRAINING_FLOOR       = 100;
const STATUS_EVERY_CYCLES  = 8;
const EQUIP_BUDGET_PCT     = 0.01;
const EQUIP_TIER1_COST     = 5_000_000;

const DEFAULT_FACTION   = "Slum Snakes";
const DIRECTIVE_STALE_MS = 10 * 60 * 1000;

const SNAP_HELPER     = "/helpers/gang-snapshot.js";
const EXEC_HELPER     = "/helpers/gang-execute.js";
const SNAP_FILE       = "/Temp/gang-snap.json";
const PENDING_FILE    = "/Temp/gang-pending.json";
const STATE_FILE      = "/Temp/gang-state.json";
const DIRECTIVES_FILE = "/Temp/gang-directives.json";
const ECON_FILE       = "/Temp/economy.json";

const LOG_FILE      = "/logs/gang.txt";
const LOG_PREV      = "/logs/gang.1.txt";
const LOG_MAX_BYTES = 256_000;

const MEMBER_NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
  "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"
];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("INFO  gang-manager v4 (slim orchestrator) up (poll " + POLL_MS + "ms)");
  appendLog(ns, "START gang-manager v4");

  if (!ns.fileExists(SNAP_FILE, "home")) {
    launchHelper(ns, SNAP_HELPER);
    await ns.sleep(1500);
  }

  let cycle = 0;
  let lastSnapshot = null;

  while (true) {
    cycle++;
    try {
      const result = tick(ns);
      if (result && (cycle % STATUS_EVERY_CYCLES === 0 || lastSnapshot === null)) {
        printStatus(ns, result);
        lastSnapshot = result;
      }
      launchHelper(ns, SNAP_HELPER); // refresh for next cycle
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

function tick(ns) {
  const snap = readJson(ns, SNAP_FILE);
  if (!snap) return null;
  if (snap.error === "no SF-2") {
    ns.print("INFO  Gang API unavailable (need Source-File 2)");
    return null;
  }

  const directives = readDirectives(ns);
  const pending = { _reqId: String(Date.now()) };

  // 0) Join a gang
  if (!snap.inGang) {
    const faction = directives.createFaction || DEFAULT_FACTION;
    pending.create = { faction };
    ns.write(PENDING_FILE, JSON.stringify(pending), "w");
    launchHelper(ns, EXEC_HELPER);
    appendLog(ns, "QUEUE create gang via " + faction);
    return null;
  }

  const info = snap.info || {};
  const isHack = !!info.isHacking;
  const focus = directives.focus || (info.respect < 1e6 ? "respect" : "money");
  const wantedRatio = info.respect > 0 ? info.wantedLevel / info.respect : 0;
  const overflow = wantedRatio > WANTED_RATIO_HIGH;

  // 1) Recruit
  const recruits = [];
  let memberCount = (snap.members || []).length;
  if (snap.canRecruit) {
    while (memberCount < MAX_MEMBERS) {
      recruits.push(MEMBER_NAMES[memberCount]);
      memberCount++;
    }
  }
  if (recruits.length) pending.recruits = recruits;

  // 2) Sort members strongest first; per-member task scoring
  const records = (snap.members || []).map((m) => {
    const i = m.info || {};
    const sum = (i.hack || 0) + (i.str || 0) + (i.def || 0) + (i.dex || 0) + (i.agi || 0) + (i.cha || 0);
    return { name: m.name, info: i, ascend: m.ascend, sum };
  }).sort((a, b) => b.sum - a.sum);

  const memberOverrides = directives.memberOverrides || {};
  const trainFloor = Number(directives.trainingFloor) || TRAINING_FLOOR;
  const vigilanteCount = overflow ? Math.max(1, Math.floor(records.length * VIGILANTE_FRACTION)) : 0;
  const taskAssignments = {};
  const tasksToSet = [];

  for (let i = 0; i < records.length; i++) {
    const { name, info: m, sum } = records[i];
    let task;
    if (memberOverrides[name]) {
      task = memberOverrides[name];
    } else if (i < vigilanteCount) {
      task = "Vigilante Justice";
    } else if (sum < trainFloor) {
      task = isHack ? "Train Hacking" : "Train Combat";
    } else {
      task = pickBestTask(snap.tasks || {}, m, isHack, focus);
    }
    taskAssignments[name] = task;
    if (m.task !== task) {
      tasksToSet.push({ name, task });
    }
  }
  if (tasksToSet.length) pending.tasks = tasksToSet;

  // 3) Rolling ascension — at most one per cycle
  const ascendBase = Number(directives.ascendThreshold) || ASCEND_BASE;
  const ascendList = [];
  for (let i = 0; i < records.length; i++) {
    if (ascendList.length) break;
    const r = records[i];
    if (!r.ascend) continue;
    const stats = isHack
      ? [r.ascend.hack]
      : [r.ascend.str || 1, r.ascend.def || 1, r.ascend.dex || 1, r.ascend.agi || 1];
    const avgMult = stats.reduce((s, v) => s + (v || 0), 0) / stats.length;
    const myThreshold = ascendBase + (records.length - 1 - i) * ASCEND_SPACING;
    if (avgMult < myThreshold) continue;
    ascendList.push(r.name);
    appendLog(ns, "QUEUE ASCEND " + r.name + " avg=" + avgMult.toFixed(2) + " threshold=" + myThreshold.toFixed(2));
  }
  if (ascendList.length) pending.ascend = ascendList;

  // 4) Equipment + augs — two-tier
  const equipAllowed = directives.allowEquipment !== false;
  const tier1Ceiling = Number(directives.equipTier1Cost) || EQUIP_TIER1_COST;
  const budgetPct = typeof directives.equipBudgetPct === "number" ? directives.equipBudgetPct : EQUIP_BUDGET_PCT;
  const equipList = [];
  if (equipAllowed) {
    const econ = readJson(ns, ECON_FILE) || {};
    const savingsThreshold = econ.savingsThreshold || 0;
    let cash = ns.getServerMoneyAvailable("home");
    let purchased = 0;

    for (const eq of (snap.equipment || [])) {
      if (cash < eq.cost) break;
      const isTier1 = eq.cost <= tier1Ceiling;
      if (!isTier1) {
        const headroom = Math.max(0, cash - savingsThreshold);
        const maxSpend = headroom * budgetPct;
        if (cash - eq.cost < savingsThreshold) continue;
        if (eq.cost > maxSpend && purchased > 0) continue;
      }
      for (const r of records) {
        const owned = (r.info.upgrades || []).concat(r.info.augmentations || []);
        if (owned.includes(eq.name)) continue;
        if (cash < eq.cost) break;
        if (!isTier1 && cash - eq.cost < savingsThreshold) break;
        equipList.push({ name: r.name, item: eq.name });
        cash -= eq.cost;
        purchased++;
        // Update local record so we don't re-buy in this cycle
        r.info.upgrades = (r.info.upgrades || []).concat([eq.name]);
        break;
      }
    }
  }
  if (equipList.length) pending.equip = equipList;

  // 5) Territory warfare — auto OR override
  let warfareDecision = null;
  if (snap.allGangs && info.faction) {
    const ours = snap.allGangs[info.faction];
    const otherPowers = Object.entries(snap.allGangs)
      .filter(([k]) => k !== info.faction)
      .map(([, g]) => g.power || 0);
    const avgOther = otherPowers.length ? otherPowers.reduce((s, p) => s + p, 0) / otherPowers.length : 0;
    const dominating = ours && ours.power > avgOther * WARFARE_POWER_RATIO;
    const allTerritory = (ours?.territory || 0) >= 0.999;
    const auto = dominating && !allTerritory;
    const dominate = (typeof directives.warfareOverride === "boolean") ? directives.warfareOverride : auto;
    if (info.territoryWarfareEngaged !== dominate) {
      pending.warfare = dominate;
      appendLog(ns, "QUEUE WARFARE " + (dominate ? "ON" : "OFF") +
                    " (us=" + (ours?.power || 0).toFixed(0) + " avg=" + avgOther.toFixed(0) + ")");
    }
    warfareDecision = dominate;
  }

  // Spawn execute helper if there's anything to do
  const hasActions = (pending.recruits || pending.tasks || pending.ascend || pending.equip ||
                      typeof pending.warfare === "boolean");
  if (hasActions) {
    ns.write(PENDING_FILE, JSON.stringify(pending), "w");
    launchHelper(ns, EXEC_HELPER);
  }

  // 6) Publish state for the AI player
  const snapshot = {
    ts: Date.now(),
    version: "GANG_MANAGER_VERSION_4",
    inGang: true,
    faction: info.faction,
    isHacking: isHack,
    focus,
    members: records.length,
    respect: info.respect,
    respectGainRate: info.respectGainRate,
    moneyGainRate: info.moneyGainRate,
    wanted: info.wantedLevel,
    wantedGainRate: info.wantedGainRate,
    wantedRatio,
    power: info.power,
    territory: info.territory,
    territoryWarfare: info.territoryWarfareEngaged,
    bonusTime: snap.bonusTime || 0,
    taskAssignments,
    cycle: {
      assigned: tasksToSet.length,
      ascended: ascendList.length,
      equipped: equipList.length,
      warfare:  warfareDecision
    }
  };
  try { ns.write(STATE_FILE, JSON.stringify(snapshot, null, 2), "w"); } catch (_) {}
  return snapshot;
}

function pickBestTask(taskCache, member, isHack, focus) {
  const fallback = isHack ? "Train Hacking" : "Train Combat";
  let best = fallback;
  let bestScore = 0;

  for (const [name, t] of Object.entries(taskCache)) {
    if (t.isHacking && !isHack) continue;
    if (t.isCombat && isHack) continue;

    const w = (
      (member.hack_asc_mult || 1) * (member.hack || 0) * (t.hackWeight || 0) +
      (member.str_asc_mult  || 1) * (member.str  || 0) * (t.strWeight  || 0) +
      (member.def_asc_mult  || 1) * (member.def  || 0) * (t.defWeight  || 0) +
      (member.dex_asc_mult  || 1) * (member.dex  || 0) * (t.dexWeight  || 0) +
      (member.agi_asc_mult  || 1) * (member.agi  || 0) * (t.agiWeight  || 0) +
      (member.cha_asc_mult  || 1) * (member.cha  || 0) * (t.chaWeight  || 0)
    ) / 100;
    const difficulty = Math.max(1, t.difficulty || 1);
    const effectiveness = Math.min(1, w / (difficulty * 100));
    if (effectiveness < 0.05) continue;

    const respectMod = (t.territory && t.territory.respect) || 1;
    const moneyMod   = (t.territory && t.territory.money)   || 1;
    const yieldScore = focus === "money"
      ? (t.baseMoney   || 0) * moneyMod   * effectiveness
      : (t.baseRespect || 0) * respectMod * effectiveness;
    if (yieldScore > bestScore) { bestScore = yieldScore; best = name; }
  }
  return bestScore > 0 ? best : fallback;
}

function printStatus(ns, snap) {
  const respectGain = snap.respectGainRate * 5;
  const moneyGain   = snap.moneyGainRate * 5;
  const tasksUsed   = new Set(Object.values(snap.taskAssignments || {}));
  ns.print(
    "INFO  members=" + snap.members + "/" + MAX_MEMBERS +
    " " + (snap.isHacking ? "HACK-gang" : "COMBAT-gang") +
    " focus=" + snap.focus +
    " respect=" + fmt(snap.respect) + " (+" + fmt(respectGain) + "/5s)" +
    " $/5s=" + fmt(moneyGain) +
    " wanted=" + fmt(snap.wanted) + " (" + (snap.wantedRatio * 100).toFixed(2) + "%)" +
    " power=" + fmt(snap.power) +
    " terr=" + ((snap.territory || 0) * 100).toFixed(1) + "%" +
    " tasks=[" + Array.from(tasksUsed).join(", ") + "]" +
    (snap.bonusTime > 1000 ? " bonus=" + (snap.bonusTime / 1000).toFixed(0) + "s" : "")
  );
}

function fmt(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

function readDirectives(ns) {
  try {
    if (!ns.fileExists(DIRECTIVES_FILE, "home")) return {};
    const raw = JSON.parse(ns.read(DIRECTIVES_FILE)) || {};
    if (raw.ts && Date.now() - raw.ts > DIRECTIVE_STALE_MS) return {};
    return raw;
  } catch (_) { return {}; }
}

function readJson(ns, path) {
  try {
    if (!ns.fileExists(path, "home")) return null;
    return JSON.parse(ns.read(path)) || null;
  } catch (_) { return null; }
}

function launchHelper(ns, file) {
  if (!ns.fileExists(file, "home")) return;
  try { ns.exec(file, "home", 1); } catch (_) {}
}

function appendLog(ns, line) {
  try {
    const ts = new Date().toISOString();
    const entry = ts + " " + String(line).replace(/\s+$/, "") + "\n";
    let cur = ns.fileExists(LOG_FILE, "home") ? ns.read(LOG_FILE) : "";
    if (cur.length + entry.length > LOG_MAX_BYTES) {
      ns.write(LOG_PREV, cur, "w");
      cur = "";
    }
    ns.write(LOG_FILE, cur + entry, "w");
  } catch (_) {}
}
