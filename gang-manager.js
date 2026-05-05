/**
 * gang-manager.js — gang autopilot v3 (AI-steerable, full-control)
 *
 * GANG_MANAGER_VERSION_3
 *
 * v3 controls EVERY gang activity exposed by the NS gang API:
 *   • createGang    — joins via DEFAULT_FACTION (or directive override)
 *   • recruitMember — up to MAX_MEMBERS (12)
 *   • setMemberTask — per-member optimal-task scoring via
 *                     getTaskStats (replaces v2's hardcoded ladder)
 *   • ascendMember  — spaced thresholds: member 0 ascends at 1.50×,
 *                     member 11 at 1.05× — produces ROLLING ascensions
 *                     instead of all-at-once retrain pile-ups
 *   • purchaseEquipment — TWO TIERS:
 *      ‣ tier 1 (≤ EQUIP_TIER1_COST = $5M): buy whenever cash > cost
 *      ‣ tier 2 (> $5M): respect savings policy. Both equipment AND
 *        augmentations flow through this loop (NS API lumps them).
 *   • setTerritoryWarfare — engage when dominating + territory < 100%
 *
 * Reads:  /Temp/economy.json (savings policy)
 *         /Temp/gang-directives.json (AI override, expires 10 min)
 * Writes: /Temp/gang-state.json (per-cycle snapshot for the AI)
 *         /logs/gang.txt (rotates at 256 KB)
 *
 * Directive shape (set via the AI's `set_gang_plan` action):
 *   {
 *     "ts": <epoch ms>,
 *     "createFaction":     "Slum Snakes",
 *     "memberOverrides":   { "Alpha": "Vigilante Justice", ... },
 *     "allowEquipment":    true,
 *     "warfareOverride":   null,         // true | false | null (=auto)
 *     "ascendThreshold":   1.20,         // override base ascend threshold
 *     "trainingFloor":     200,
 *     "focus":             "respect",    // "respect" | "money"
 *     "equipBudgetPct":    0.01,         // pct of liquid cash per cycle
 *     "equipTier1Cost":    5000000       // $ ceiling for "always-buy" tier
 *   }
 */

const POLL_MS              = 4_000;
const MAX_MEMBERS          = 12;
const ASCEND_BASE          = 1.05;        // floor — member 11 ascends at this
const ASCEND_SPACING       = 0.05;        // each member up the list ascends 0.05× higher
const WARFARE_POWER_RATIO  = 1.5;
const WANTED_RATIO_HIGH    = 0.10;
const VIGILANTE_FRACTION   = 0.40;
const TRAINING_FLOOR       = 100;
const STATUS_EVERY_CYCLES  = 8;
const EQUIP_BUDGET_PCT     = 0.01;        // 1% of liquid cash per cycle on equipment
const EQUIP_TIER1_COST     = 5_000_000;   // ≤ this is "always buy" if affordable

const LOG_FILE             = "/logs/gang.txt";
const LOG_PREV             = "/logs/gang.1.txt";
const LOG_MAX_BYTES        = 256_000;

const DIRECTIVES_FILE      = "/Temp/gang-directives.json";
const STATE_FILE           = "/Temp/gang-state.json";
const DIRECTIVE_STALE_MS   = 10 * 60 * 1000;
const DEFAULT_FACTION      = "Slum Snakes";

const MEMBER_NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
  "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"
];

// Tasks we treat specially and exclude from the auto-scoring pool.
const SPECIAL_TASKS = new Set([
  "Unassigned", "Vigilante Justice", "Territory Warfare",
  "Train Combat", "Train Hacking", "Train Charisma"
]);

// Cache task stats (constant across the run) and equipment metadata.
let TASK_STATS_CACHE  = null;
let EQUIPMENT_CACHE   = null;  // [{ name, cost, type, stats }]

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  ns.print("INFO  gang-manager v3 up (poll " + POLL_MS + "ms)");
  appendLog(ns, "START gang-manager v3");

  let cycle = 0;
  let lastSnapshot = null;
  let lastSnapshotTime = 0;

  while (true) {
    cycle++;
    try {
      const result = await tick(ns);
      if (result && (cycle % STATUS_EVERY_CYCLES === 0 || lastSnapshot === null)) {
        printStatus(ns, result, lastSnapshot, lastSnapshotTime);
        lastSnapshot = result;
        lastSnapshotTime = Date.now();
      }
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

/** @param {NS} ns */
async function tick(ns) {
  const directives = readDirectives(ns);

  // 0) join a gang if we aren't in one
  if (!ns.gang.inGang()) {
    const faction = directives.createFaction || DEFAULT_FACTION;
    if (!ns.gang.createGang(faction)) return null;
    appendLog(ns, "JOIN created gang via " + faction);
    TASK_STATS_CACHE = null; // re-cache once we know hack vs combat
  }

  const info     = ns.gang.getGangInformation();
  const isHack   = !!info.isHacking;
  const focus    = directives.focus || (info.respect < 1e6 ? "respect" : "money");
  const taskCache = getTaskStats(ns);
  const wantedRatio = info.respect > 0 ? info.wantedLevel / info.respect : 0;
  const overflow    = wantedRatio > WANTED_RATIO_HIGH;

  // 1) recruit
  const members = ns.gang.getMemberNames();
  while (members.length < MAX_MEMBERS && ns.gang.canRecruitMember()) {
    const name = MEMBER_NAMES[members.length];
    if (!ns.gang.recruitMember(name)) break;
    members.push(name);
    appendLog(ns, "RECRUIT " + name + " (now " + members.length + ")");
  }

  // 2) collect per-member info, sort strongest first (vigilante goes
  //    to top members; bottom members handle income).
  const records = members.map(name => {
    const m = ns.gang.getMemberInformation(name);
    const sum = (m.hack || 0) + (m.str || 0) + (m.def || 0)
              + (m.dex || 0) + (m.agi || 0) + (m.cha || 0);
    return { name, m, sum };
  }).sort((a, b) => b.sum - a.sum);

  // 3) per-member task scoring — replaces v2's hardcoded ladder.
  const memberOverrides = directives.memberOverrides || {};
  const trainFloor      = Number(directives.trainingFloor) || TRAINING_FLOOR;
  const vigilanteCount  = overflow ? Math.max(1, Math.floor(records.length * VIGILANTE_FRACTION)) : 0;

  let assigned = 0;
  const taskAssignments = {};

  for (let i = 0; i < records.length; i++) {
    const { name, m, sum } = records[i];
    let task;
    if (memberOverrides[name]) {
      task = memberOverrides[name];                                       // AI override
    } else if (i < vigilanteCount) {
      task = "Vigilante Justice";                                         // wanted control
    } else if (sum < trainFloor) {
      task = isHack ? "Train Hacking" : "Train Combat";
    } else {
      task = pickBestTask(taskCache, m, isHack, focus);
    }
    taskAssignments[name] = task;

    if (m.task !== task) {
      if (ns.gang.setMemberTask(name, task)) {
        assigned++;
        appendLog(ns, "TASK " + name + " (Σ=" + Math.round(sum) + ") -> " + task +
                      (memberOverrides[name] ? " [directive]" : ""));
      }
    }
  }

  // 4) ascend with SPACED thresholds. Member 0 (strongest) ascends
  //    at the highest threshold; member 11 at the lowest. This
  //    produces rolling ascensions — the gang isn't all retraining
  //    at the same time.
  const ascendBase = Number(directives.ascendThreshold) || ASCEND_BASE;
  let ascended = false;
  for (let i = 0; i < records.length; i++) {
    if (ascended) break;
    const { name } = records[i];
    let next = null;
    try { next = ns.gang.getAscensionResult(name); } catch (_) {}
    if (!next) continue;
    const stats = isHack
      ? [next.hack]
      : [next.str || 1, next.def || 1, next.dex || 1, next.agi || 1];
    const avgMult = stats.reduce((s, v) => s + (v || 0), 0) / stats.length;
    // Strongest gets highest threshold (don't ascend lightly), weakest the lowest.
    const myThreshold = ascendBase + (records.length - 1 - i) * ASCEND_SPACING;
    if (avgMult < myThreshold) continue;
    if (ns.gang.ascendMember(name)) {
      ns.print("SUCCESS  Ascended " + name + " (avg " + avgMult.toFixed(2) +
               "× ≥ " + myThreshold.toFixed(2) + "×)");
      appendLog(ns, "ASCEND " + name + " avg=" + avgMult.toFixed(2) +
                    " threshold=" + myThreshold.toFixed(2));
      ascended = true;
    }
  }

  // 5) equipment + augmentations — two-tier buying.
  //    Tier 1 (≤ EQUIP_TIER1_COST): always buy if affordable. Cheap
  //    items compound stat growth fast and are cheap enough that
  //    they don't meaningfully threaten savings.
  //    Tier 2 (> tier1 cost): respect savings policy.
  const equipAllowed = directives.allowEquipment !== false;
  const tier1Ceiling = Number(directives.equipTier1Cost) || EQUIP_TIER1_COST;
  const budgetPct    = typeof directives.equipBudgetPct === "number"
                       ? directives.equipBudgetPct
                       : EQUIP_BUDGET_PCT;
  let equipped = 0;
  if (equipAllowed) {
    equipped = buyGear(ns, records, tier1Ceiling, budgetPct);
  }

  // 6) territory warfare
  let warfareDecision = null;
  try {
    const all = ns.gang.getAllGangInformation();
    const ours = all[info.faction];
    const otherPowers = Object.entries(all)
      .filter(([k]) => k !== info.faction)
      .map(([, g]) => g.power || 0);
    const avgOther = otherPowers.length
      ? otherPowers.reduce((s, p) => s + p, 0) / otherPowers.length
      : 0;
    const dominating = ours && ours.power > avgOther * WARFARE_POWER_RATIO;
    const allTerritory = (ours?.territory || 0) >= 0.999;
    const auto = dominating && !allTerritory;
    const dominate = (typeof directives.warfareOverride === "boolean")
      ? directives.warfareOverride
      : auto;
    if (info.territoryWarfareEngaged !== dominate) {
      ns.gang.setTerritoryWarfare(dominate);
      appendLog(ns, "WARFARE " + (dominate ? "ON" : "OFF") +
                    " (us=" + (ours?.power || 0).toFixed(0) +
                    " avg=" + avgOther.toFixed(0) + ")");
    }
    warfareDecision = dominate;
  } catch (_) {}

  // 7) per-cycle state for the AI
  const snapshot = {
    ts:                Date.now(),
    version:           "GANG_MANAGER_VERSION_3",
    inGang:            true,
    faction:           info.faction,
    isHacking:         isHack,
    focus,
    members:           members.length,
    respect:           info.respect,
    respectGainRate:   info.respectGainRate,
    moneyGainRate:     info.moneyGainRate,
    wanted:            info.wantedLevel,
    wantedGainRate:    info.wantedGainRate,
    wantedRatio,
    power:             info.power,
    territory:         info.territory,
    territoryWarfare:  info.territoryWarfareEngaged,
    bonusTime:         safe(() => ns.gang.getBonusTime()) || 0,
    taskAssignments,
    cycle: { assigned, ascended, equipped, warfare: warfareDecision }
  };
  try { ns.write(STATE_FILE, JSON.stringify(snapshot, null, 2), "w"); } catch (_) {}
  return snapshot;
}

// ─── task scoring ───────────────────────────────────────────────────
function getTaskStats(ns) {
  if (TASK_STATS_CACHE) return TASK_STATS_CACHE;
  TASK_STATS_CACHE = {};
  let names;
  try { names = ns.gang.getTaskNames(); } catch (_) { return TASK_STATS_CACHE; }
  for (const n of names) {
    try { TASK_STATS_CACHE[n] = ns.gang.getTaskStats(n); } catch (_) {}
  }
  return TASK_STATS_CACHE;
}

// Simplified Bitburner gang task gain formula. A member's contribution
// to a task scales with their stats weighted by the task's stat
// weights, divided by task difficulty. We score by yield-per-second
// of either respect (early game) or money (late game), prioritising
// tasks the member is actually effective at.
function pickBestTask(taskCache, member, isHack, focus) {
  const fallback = isHack ? "Train Hacking" : "Train Combat";
  let best = fallback;
  let bestScore = 0;

  for (const [name, t] of Object.entries(taskCache)) {
    if (SPECIAL_TASKS.has(name)) continue;
    if (t.isHacking && !isHack) continue;
    if (t.isCombat && isHack) continue;

    // Member's weighted stat for this task
    const w = (
      (member.hack_asc_mult || 1) * (member.hack || 0) * (t.hackWeight || 0) +
      (member.str_asc_mult  || 1) * (member.str  || 0) * (t.strWeight  || 0) +
      (member.def_asc_mult  || 1) * (member.def  || 0) * (t.defWeight  || 0) +
      (member.dex_asc_mult  || 1) * (member.dex  || 0) * (t.dexWeight  || 0) +
      (member.agi_asc_mult  || 1) * (member.agi  || 0) * (t.agiWeight  || 0) +
      (member.cha_asc_mult  || 1) * (member.cha  || 0) * (t.chaWeight  || 0)
    ) / 100;
    const difficulty = Math.max(1, t.difficulty || 1);

    // Effectiveness: roughly weightedStat / difficulty, capped at 1.
    const effectiveness = Math.min(1, w / (difficulty * 100));
    if (effectiveness < 0.05) continue;

    const respectMod = (t.territory && t.territory.respect) || 1;
    const moneyMod   = (t.territory && t.territory.money)   || 1;

    const yieldScore = focus === "money"
      ? (t.baseMoney   || 0) * moneyMod   * effectiveness
      : (t.baseRespect || 0) * respectMod * effectiveness;

    if (yieldScore > bestScore) {
      bestScore = yieldScore;
      best = name;
    }
  }
  return bestScore > 0 ? best : fallback;
}

// ─── equipment / augmentation buying ───────────────────────────────
function getEquipmentCache(ns) {
  if (EQUIPMENT_CACHE) return EQUIPMENT_CACHE;
  EQUIPMENT_CACHE = [];
  let names;
  try { names = ns.gang.getEquipmentNames(); } catch (_) { return EQUIPMENT_CACHE; }
  for (const n of names) {
    try {
      EQUIPMENT_CACHE.push({
        name: n,
        cost: ns.gang.getEquipmentCost(n),
        type: ns.gang.getEquipmentType ? ns.gang.getEquipmentType(n) : "Equipment"
      });
    } catch (_) {}
  }
  EQUIPMENT_CACHE.sort((a, b) => a.cost - b.cost);
  return EQUIPMENT_CACHE;
}

function buyGear(ns, records, tier1Ceiling, budgetPct) {
  const equipment = getEquipmentCache(ns);
  if (!equipment.length) return 0;

  const econ = readEconomy(ns);
  const savingsThreshold = econ?.savingsThreshold || 0;
  let purchased = 0;

  for (const equip of equipment) {
    const cash = ns.getServerMoneyAvailable("home");
    if (cash < equip.cost) break; // sorted ascending — nothing else affordable

    const isTier1 = equip.cost <= tier1Ceiling;
    if (!isTier1) {
      // Tier 2: respect savings AND a per-cycle budget cap.
      const headroomCash = Math.max(0, cash - savingsThreshold);
      const maxSpendThisCycle = headroomCash * budgetPct;
      if (cash - equip.cost < savingsThreshold) continue;     // would breach savings
      if (equip.cost > maxSpendThisCycle && purchased > 0) continue; // budget exhausted
    }

    for (const { name, m } of records) {
      const owned = (m.upgrades || []).concat(m.augmentations || []);
      if (owned.includes(equip.name)) continue;
      const cashNow = ns.getServerMoneyAvailable("home");
      if (cashNow < equip.cost) return purchased;
      if (!isTier1 && cashNow - equip.cost < savingsThreshold) return purchased;
      if (ns.gang.purchaseEquipment(name, equip.name)) {
        purchased++;
        appendLog(ns, "EQUIP " + name + " " + equip.name + " (" + equip.type +
                      ", $" + equip.cost.toLocaleString() + ")");
        // Update local member record so we don't re-buy in this cycle
        m.upgrades = (m.upgrades || []).concat([equip.name]);
        break;
      }
    }
  }
  return purchased;
}

// ─── status / state helpers ────────────────────────────────────────
function printStatus(ns, snap, prev, prevTime) {
  const respectGain = snap.respectGainRate * 5;
  const moneyGain   = snap.moneyGainRate * 5;
  const tasksUsed   = new Set(Object.values(snap.taskAssignments));
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

function readEconomy(ns) {
  try {
    if (!ns.fileExists("/Temp/economy.json", "home")) return null;
    return JSON.parse(ns.read("/Temp/economy.json")) || null;
  } catch (_) { return null; }
}

function safe(fn) { try { return fn(); } catch (_) { return null; } }

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
