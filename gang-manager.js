/**
 * gang-manager.js — gang autopilot v2 (AI-steerable)
 *
 * GANG_MANAGER_VERSION_2
 *
 * What changed vs v1:
 *   • POLL_MS dropped from 30 s → 4 s. Gang stats tick every 2 s in
 *     the game; the v1 cadence was so slow that the loop printed the
 *     same numbers many cycles in a row and tasks barely escalated.
 *   • Per-member task escalation by combat-stat tier — no more
 *     "everyone does the same thing forever":
 *         < 200       Train Combat
 *         < 800       Mug People
 *         < 1500      Strongarm Civilians
 *         < 3000      Run a Con
 *         < 6000      Armed Robbery
 *         < 12000     Traffick Illegal Arms
 *         < 25000     Threaten & Blackmail
 *         < 60000     Human Trafficking
 *         else        Terrorism
 *     Wanted-ratio override pulls top members to Vigilante Justice
 *     when wantedLevel/respect > WANTED_RATIO_HIGH.
 *   • Auto-ascend threshold dropped 1.50× → 1.10×. Members ascend
 *     much more often, so combat stats compound faster (spaced
 *     enough that not everyone is retraining at once).
 *   • Territory Warfare auto-engages once power dominates the
 *     average (>= 1.5×) AND we hold < 100% territory; disengages
 *     once we hold 100%.
 *   • Per-cycle status line now shows respect/money/wanted rates
 *     so you can SEE progression instead of staring at a static
 *     "members=12/12" line.
 *
 * Reads:  /Temp/economy.json (savings policy)
 *         /Temp/gang-directives.json (AI override, optional, expires 10 min)
 * Writes: /Temp/gang-state.json (per-cycle snapshot for the AI)
 *         /logs/gang.txt (rotates at 256 KB)
 *
 * Directive shape (set via the AI's `set_gang_plan` action):
 *   {
 *     "ts": <epoch ms>,
 *     "createFaction":   "Slum Snakes",   // override on createGang
 *     "memberOverrides": { "Alpha": "Vigilante Justice", ... },
 *     "allowEquipment":  true,            // false to pause equip buying
 *     "warfareOverride": null,            // true | false | null (=auto)
 *     "ascendThreshold": 1.10,            // override per-cycle
 *     "trainingFloor":   200              // override stat-sum cutoff for Train Combat
 *   }
 */

const POLL_MS              = 4_000;
const MAX_MEMBERS          = 12;
const ASCEND_THRESHOLD     = 1.10;        // avg multiplier across str/def/dex/agi
const WARFARE_POWER_RATIO  = 1.5;         // engage when our power > avg * ratio
const WANTED_RATIO_HIGH    = 0.10;        // wantedLevel/respect threshold
const VIGILANTE_FRACTION   = 0.40;        // pull this fraction of high-stat members to vigilante
const TRAINING_FLOOR       = 200;         // stat-sum below which we train
const STATUS_EVERY_CYCLES  = 8;           // print status line every Nth cycle (≈ 32 s)

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

// Tiers used by combat gangs. Charisma-relevant tasks like "Human
// Trafficking" still benefit from raw stat sum so we leave them in the
// ladder; if your save is a hacking gang, consider replacing these
// names with the hacking equivalents (Phishing Scams, Money Laundering,
// etc.) — set them via `set_gang_plan` directives or fork this file.
const TASK_LADDER = [
  { upTo:    200, task: "Train Combat" },
  { upTo:    800, task: "Mug People" },
  { upTo:   1500, task: "Strongarm Civilians" },
  { upTo:   3000, task: "Run a Con" },
  { upTo:   6000, task: "Armed Robbery" },
  { upTo:  12000, task: "Traffick Illegal Arms" },
  { upTo:  25000, task: "Threaten & Blackmail" },
  { upTo:  60000, task: "Human Trafficking" },
  { upTo: Infinity, task: "Terrorism" }
];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  ns.print("INFO  gang-manager v2 up (poll " + POLL_MS + "ms)");
  appendLog(ns, "START gang-manager v2");

  let cycle = 0;
  let lastSnapshot = null;
  let lastSnapshotTime = 0;

  while (true) {
    cycle++;
    try {
      const result = await tick(ns);
      // Every Nth cycle, print a status line with rates.
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

  if (!ns.gang.inGang()) {
    const faction = directives.createFaction || DEFAULT_FACTION;
    if (!ns.gang.createGang(faction)) {
      // Quiet — printed once at startup is enough; don't spam every 4s
      return null;
    }
    appendLog(ns, "JOIN created gang via " + faction);
  }

  const info    = ns.gang.getGangInformation();
  const members = ns.gang.getMemberNames();
  const econ    = readEconomy(ns);
  const ascendThr = Number(directives.ascendThreshold) || ASCEND_THRESHOLD;
  const trainFloor = Number(directives.trainingFloor) || TRAINING_FLOOR;

  // 1) recruit up to MAX_MEMBERS
  while (members.length < MAX_MEMBERS && ns.gang.canRecruitMember()) {
    const name = MEMBER_NAMES[members.length];
    if (!ns.gang.recruitMember(name)) break;
    members.push(name);
    appendLog(ns, "RECRUIT " + name + " (now " + members.length + ")");
  }

  // 2) compute wanted ratio — drives Vigilante override
  const wantedRatio = info.respect > 0 ? info.wantedLevel / info.respect : 0;
  const overflow = wantedRatio > WANTED_RATIO_HIGH;

  // 3) collect member info, sort by stat sum desc — the strongest go
  //    on Vigilante when wanted is high (they recover wanted faster).
  const memberRecords = members.map(name => {
    const m = ns.gang.getMemberInformation(name);
    const sum = (m.str || 0) + (m.def || 0) + (m.dex || 0) + (m.agi || 0);
    return { name, m, sum };
  }).sort((a, b) => b.sum - a.sum);

  const memberOverrides = directives.memberOverrides || {};
  const vigilanteCount = overflow ? Math.max(1, Math.floor(memberRecords.length * VIGILANTE_FRACTION)) : 0;
  let assigned = 0;

  for (let i = 0; i < memberRecords.length; i++) {
    const { name, m, sum } = memberRecords[i];
    let task;
    if (memberOverrides[name]) {
      task = memberOverrides[name];                                       // AI override
    } else if (i < vigilanteCount) {
      task = "Vigilante Justice";                                         // wanted-control
    } else if (sum < trainFloor) {
      task = "Train Combat";                                              // baseline training
    } else {
      task = pickTaskForStats(sum);                                       // ladder
    }
    if (m.task !== task) {
      if (ns.gang.setMemberTask(name, task)) {
        assigned++;
        appendLog(ns, "TASK " + name + " (" + Math.round(sum) + ") -> " + task +
                      (memberOverrides[name] ? " [directive]" : ""));
      }
    }
  }

  // 4) ascend high-multiplier members. Lower threshold + space them
  //    out (only ascend one per cycle so the gang isn't all retraining).
  let ascended = false;
  for (const { name } of memberRecords) {
    if (ascended) break;
    let next = null;
    try { next = ns.gang.getAscensionResult(name); } catch (_) {}
    if (!next) continue;
    const avg = ((next.str || 0) + (next.def || 0) + (next.dex || 0) + (next.agi || 0)) / 4;
    if (avg < ascendThr) continue;
    if (ns.gang.ascendMember(name)) {
      ns.print("SUCCESS  Ascended " + name + " (avg " + avg.toFixed(2) + "x)");
      appendLog(ns, "ASCEND " + name + " avg=" + avg.toFixed(2));
      ascended = true;
    }
  }

  // 5) equipment — only when savings unlocked AND directive doesn't
  //    disable it. Buy one item per cycle to spread the spend out.
  const equipAllowed = directives.allowEquipment !== false;
  let equipped = 0;
  if (equipAllowed && econ && econ.savingsThreshold !== undefined) {
    const cash      = ns.getServerMoneyAvailable("home");
    const threshold = econ.savingsThreshold;
    if (cash >= threshold) {
      outer: for (const equip of ns.gang.getEquipmentNames()) {
        let cost = Infinity;
        try { cost = ns.gang.getEquipmentCost(equip); } catch (_) {}
        if (cost === Infinity || cash - cost < threshold) continue;
        for (const { name, m } of memberRecords) {
          const owned = (m.upgrades || []).concat(m.augmentations || []);
          if (owned.includes(equip)) continue;
          if (ns.gang.purchaseEquipment(name, equip)) {
            equipped++;
            appendLog(ns, "EQUIP " + name + " " + equip + " ($" + cost.toLocaleString() + ")");
            break outer; // one purchase per cycle
          }
        }
      }
    }
  }

  // 6) territory warfare — directive override OR auto-engage when
  //    we dominate AND we don't already hold 100% territory.
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
                    " avg=" + avgOther.toFixed(0) +
                    " ours_territory=" + ((ours?.territory || 0) * 100).toFixed(1) + "%)" +
                    (typeof directives.warfareOverride === "boolean" ? " [directive]" : ""));
    }
    warfareDecision = dominate;
  } catch (_) { /* warfare API can throw early-game */ }

  // 7) publish per-cycle state for the AI player.
  const snapshot = {
    ts:                Date.now(),
    inGang:            true,
    faction:           info.faction,
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
    cycle: { assigned, ascended, equipped, warfare: warfareDecision }
  };
  try { ns.write(STATE_FILE, JSON.stringify(snapshot, null, 2), "w"); } catch (_) {}
  return snapshot;
}

function pickTaskForStats(sum) {
  for (const tier of TASK_LADDER) {
    if (sum < tier.upTo) return tier.task;
  }
  return TASK_LADDER[TASK_LADDER.length - 1].task;
}

function printStatus(ns, snap, prev, prevTime) {
  const dt = prev ? (Date.now() - prevTime) / 1000 : 0;
  const dRespect = prev ? Math.max(0, snap.respect - prev.respect) : 0;
  const respectPerSec = dt > 0 ? dRespect / dt : 0;
  const moneyPerSec = snap.moneyGainRate * 5;     // game scales gain rate per 5s
  const respectGain = snap.respectGainRate * 5;
  ns.print(
    "INFO  members=" + snap.members + "/" + MAX_MEMBERS +
    " respect=" + fmt(snap.respect) + " (+" + fmt(respectGain) + "/5s)" +
    " $/5s=" + fmt(moneyPerSec) +
    " wanted=" + fmt(snap.wanted) + " ratio=" + (snap.wantedRatio * 100).toFixed(2) + "%" +
    " power=" + fmt(snap.power) +
    " terr=" + ((snap.territory || 0) * 100).toFixed(1) + "%"
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
