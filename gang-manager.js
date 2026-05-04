/**
 * gang-manager.js — minimal gang autopilot (our own clean implementation)
 *
 * GANG_MANAGER_VERSION_1
 *
 * What it does, in priority order each cycle:
 *   1. Join a gang via createGang("Slum Snakes") if we're not in
 *      one yet (requires either karma <= -54000 OR Slum Snakes
 *      faction membership). Silently waits otherwise.
 *   2. Recruit up to MAX_MEMBERS while canRecruitMember() is true.
 *   3. Assign each member a task chosen by their combat stat sum
 *      and the gang's wanted-level/respect ratio:
 *         < 200 stat sum         → "Train Combat"
 *         wanted/respect > 1     → "Vigilante Justice"
 *         respect > 1M           → "Trafficking Illegal Arms"
 *         otherwise              → "Mug People"
 *   4. Ascend members whose ascensionResult averages ≥ ASCEND_THRESHOLD
 *      across str/def/dex/agi.
 *   5. Buy equipment / augmentations when affordable AND the global
 *      savings policy is unlocked (reads /Temp/economy.json from
 *      scb.js).
 *   6. Toggle territory warfare on when our power exceeds the
 *      cross-gang average by WARFARE_POWER_RATIO.
 *
 * Reads:  /Temp/economy.json  (savings policy from scb.js)
 * Writes: /logs/gang.txt      (one line per decision; rotates at 256 KB)
 */

const POLL_MS              = 30_000;
const MAX_MEMBERS          = 12;
const ASCEND_THRESHOLD     = 1.5;     // avg multiplier across 4 combat stats
const WARFARE_POWER_RATIO  = 1.2;     // engage when our power > avg * ratio
const LOG_FILE             = "/logs/gang.txt";
const LOG_PREV             = "/logs/gang.1.txt";
const LOG_MAX_BYTES        = 256_000;
const DIRECTIVES_FILE      = "/Temp/gang-directives.json";
const STATE_FILE           = "/Temp/gang-state.json";
const DIRECTIVE_STALE_MS   = 10 * 60 * 1000;
const DEFAULT_FACTION      = "Slum Snakes";

// AI directive shape (set via `set_gang_plan` action):
//   {
//     "ts": <epoch ms>,
//     "createFaction":   "Slum Snakes",   // override on createGang
//     "memberOverrides": { "Alpha": "Vigilante Justice", ... },
//     "allowEquipment":  true,            // false to pause equipment buying
//     "warfareOverride": null             // true | false | null (=auto)
//   }

const MEMBER_NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
  "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"
];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  ns.print("INFO  gang-manager v1 up");
  appendLog(ns, "START gang-manager v1");

  while (true) {
    try {
      await tick(ns);
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
      ns.print("INFO  not in a gang yet — need karma ≤ -54000 or " + faction + " membership");
      return;
    }
    appendLog(ns, "JOIN created gang via " + faction);
  }

  const info    = ns.gang.getGangInformation();
  const members = ns.gang.getMemberNames();
  const wantedRatio = info.respect > 0 ? info.wantedLevel / info.respect : 0;
  const econ    = readEconomy(ns);

  // 1) recruit
  while (members.length < MAX_MEMBERS && ns.gang.canRecruitMember()) {
    const name = MEMBER_NAMES[members.length];
    if (!ns.gang.recruitMember(name)) break;
    members.push(name);
    appendLog(ns, "RECRUIT " + name + " (now " + members.length + ")");
  }

  // 2) task each member — directive overrides take precedence
  const memberOverrides = directives.memberOverrides || {};
  for (const name of members) {
    const m = ns.gang.getMemberInformation(name);
    const sum = (m.str || 0) + (m.def || 0) + (m.dex || 0) + (m.agi || 0);
    let task;
    if (memberOverrides[name]) {
      task = memberOverrides[name];               // AI override
    } else if (sum < 200) {
      task = "Train Combat";
    } else if (wantedRatio > 1) {
      task = "Vigilante Justice";
    } else if (info.respect > 1_000_000) {
      task = "Trafficking Illegal Arms";
    } else {
      task = "Mug People";
    }
    if (m.task !== task) {
      if (ns.gang.setMemberTask(name, task)) {
        appendLog(ns, "TASK " + name + " -> " + task +
                      (memberOverrides[name] ? " (directive)" : ""));
      }
    }
  }

  // 3) ascend high-multiplier members
  for (const name of members) {
    let next = null;
    try { next = ns.gang.getAscensionResult(name); } catch (_) {}
    if (!next) continue;
    const avg = ((next.str || 0) + (next.def || 0) + (next.dex || 0) + (next.agi || 0)) / 4;
    if (avg < ASCEND_THRESHOLD) continue;
    if (ns.gang.ascendMember(name)) {
      ns.print("SUCCESS  Ascended " + name + " (avg " + avg.toFixed(2) + "x)");
      appendLog(ns, "ASCEND " + name + " avg=" + avg.toFixed(2));
    }
  }

  // 4) equipment — only when savings unlocked, AI hasn't disabled it,
  //    and only items we can afford without crossing the threshold.
  const equipAllowed = directives.allowEquipment !== false;
  if (equipAllowed && econ && econ.savingsThreshold !== undefined) {
    const cash      = ns.getServerMoneyAvailable("home");
    const threshold = econ.savingsThreshold;
    const unlocked  = cash >= threshold;
    if (unlocked) {
      for (const equip of ns.gang.getEquipmentNames()) {
        let cost = Infinity;
        try { cost = ns.gang.getEquipmentCost(equip); } catch (_) {}
        if (cash - cost < threshold) continue;
        for (const name of members) {
          const m = ns.gang.getMemberInformation(name);
          const owned = (m.upgrades || []).concat(m.augmentations || []);
          if (owned.includes(equip)) continue;
          if (ns.gang.purchaseEquipment(name, equip)) {
            appendLog(ns, "EQUIP " + name + " " + equip + " ($" + cost.toLocaleString() + ")");
            break; // one equip per cycle keeps cash flowing
          }
        }
      }
    }
  }

  // 5) territory warfare — directive override OR auto-engage when dominant
  try {
    const all = ns.gang.getAllGangInformation();
    const ours = all[info.faction];
    const otherPowers = Object.entries(all)
      .filter(([k]) => k !== info.faction)
      .map(([, g]) => g.power || 0);
    const avgOther = otherPowers.length
      ? otherPowers.reduce((s, p) => s + p, 0) / otherPowers.length
      : 0;
    const auto = ours && ours.power > avgOther * WARFARE_POWER_RATIO;
    const dominate = (typeof directives.warfareOverride === "boolean")
      ? directives.warfareOverride
      : auto;
    if (info.territoryWarfareEngaged !== dominate) {
      ns.gang.setTerritoryWarfare(dominate);
      appendLog(ns, "WARFARE " + (dominate ? "ON" : "OFF") +
                    " (us=" + (ours?.power || 0).toFixed(0) +
                    " avg="  + avgOther.toFixed(0) + ")" +
                    (typeof directives.warfareOverride === "boolean" ? " (directive)" : ""));
    }
  } catch (_) { /* warfare API can throw early-game */ }

  ns.print("INFO  members=" + members.length + "/" + MAX_MEMBERS +
           " respect=" + fmt(info.respect) +
           " wanted=" + fmt(info.wantedLevel) +
           " power=" + fmt(info.power));

  // Publish per-cycle state for the AI player to read.
  try {
    ns.write(STATE_FILE, JSON.stringify({
      ts:        Date.now(),
      inGang:    true,
      faction:   info.faction,
      members:   members.length,
      respect:   info.respect,
      wanted:    info.wantedLevel,
      power:     info.power,
      territory: info.territory,
      warfare:   info.territoryWarfareEngaged,
    }, null, 2), "w");
  } catch (_) {}
}

function readDirectives(ns) {
  try {
    if (!ns.fileExists(DIRECTIVES_FILE, "home")) return {};
    const raw = JSON.parse(ns.read(DIRECTIVES_FILE)) || {};
    if (raw.ts && Date.now() - raw.ts > DIRECTIVE_STALE_MS) return {};
    return raw;
  } catch (_) { return {}; }
}

function fmt(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
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
