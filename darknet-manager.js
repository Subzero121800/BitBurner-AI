/**
 * darknet-manager.js — Darknet autopilot v1 (slim orchestrator)
 *
 * DARKNET_MANAGER_VERSION_5
 *
 * v4 changes:
 *   - Password solver: reads auth.model from snapshot and derives the
 *     correct password per server (ZeroLogon → "", others TBD).
 *   - Heartbleed now runs in real mode (peek=false) so it actually
 *     extracts memory from targets, which can reveal deeper nodes.
 *   - Snapshot v4 adds labradar() for full node discovery.
 *
 * Bitburner 3.0.0 introduced the ns.dnet namespace (Darknet — replaces
 * legacy darkweb). This manager owns long-lived authenticated sessions
 * (tied to its PID) and steers a snapshot/execute split:
 *   - /helpers/darknet-snapshot.js (read state, transient)
 *   - /helpers/darknet-execute.js  (heavy ops, transient)
 *   - darknet-manager.js           (this file — auth + stasis only)
 *
 * Password models (derived from ns.dnet.getServerAuthDetails().model):
 *   ZeroLogon  — password is "" (empty string; proven in-game)
 *   (others)   — unknown; we record failures and log the model for research
 *
 * RAM-resident surface: only ns.dnet.authenticate, connectToSession,
 * setStasisLink, getServerAuthDetails. Everything else lives in helpers.
 */

const POLL_MS                  = 30_000;
const DIRECTIVE_STALE_MS       = 10 * 60 * 1000;
const DEFAULT_AUTH_MS          = 0;          // additionalMsec param to authenticate
const DEFAULT_HEARTBLEED_PEEK  = false;      // real heartbleed — extracts memory + reveals nodes
const DEFAULT_HEARTBLEED_TH    = 4;
const DEFAULT_PHISH_TH         = 4;
const DEFAULT_MEMREAL_TH       = 1;
const DEFAULT_MIGRATE_TH       = 4;
const MAX_AUTH_PER_CYCLE       = 3;
const MAX_OPS_PER_CYCLE        = 6;

const SNAP_HELPER     = "/helpers/darknet-snapshot.js";
const CRAWLER_HELPER  = "/helpers/darknet-crawler.js";
const EXEC_HELPER     = "/helpers/darknet-execute.js";
const SNAP_FILE       = "/Temp/darknet-snap.json";
const PENDING_FILE    = "/Temp/darknet-pending.json";
const STATE_FILE      = "/Temp/darknet-state.json";
const DIRECTIVES_FILE = "/Temp/darknet-directives.json";
const SESSIONS_FILE   = "/Temp/darknet-sessions.json";

const LOG_FILE      = "/logs/darknet.txt";
const LOG_PREV      = "/logs/darknet.1.txt";
const LOG_MAX_BYTES = 256_000;

// In-process session table — these are the authenticated sessions
// this PID owns. host -> { password, openedAt, depth, requiredCha }.
const SESSIONS = new Map();

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("INFO  darknet-manager v4 up (password solver + real heartbleed)");
  appendLog(ns, "START darknet-manager v1");

  if (!ns.dnet) {
    ns.print("ERROR  ns.dnet unavailable — game version pre-3.0.0?");
    appendLog(ns, "ABORT ns.dnet unavailable");
    publishState(ns, { supported: false });
    return;
  }

  // Bootstrap snapshot before the first tick.
  if (!ns.fileExists(SNAP_FILE, "home")) {
    launchHelper(ns, SNAP_HELPER);
    await ns.sleep(1500);
  }

  let lastSig = null;

  while (true) {
    try {
      const sig = await tick(ns);
      if (sig && sig !== lastSig) {
        appendLog(ns, "STATUS " + sig);
        lastSig = sig;
      }
      launchHelper(ns, SNAP_HELPER);
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

async function tick(ns) {
  const snap = readJson(ns, SNAP_FILE);
  if (!snap || !snap.supported) {
    ns.print("INFO  waiting for darknet snapshot");
    return null;
  }
  if (!snap.hasNavigator) {
    ns.print("WARN  DarkscapeNavigator.exe not purchased — manager idle");
    publishState(ns, { supported: true, hasNavigator: false, instability: snap.instability });
    return "idle:no-navigator";
  }

  const directives = readDirectives(ns);
  const mode = String(directives.mode || "auto").toLowerCase();

  if (mode === "off") {
    publishState(ns, snapshotToState(snap, { mode, ops: [], auths: [] }));
    return "off";
  }

  // 1) Authentication pass — try to expand session coverage.
  const auths = (mode === "manual") ? [] : await authenticatePass(ns, snap, directives);

  // 2) Stasis link pass — push the policy decision.
  const stasisQueued = stasisPass(ns, snap, directives);

  // 3) Heavy-op queue.
  const ops = (mode === "manual") ? [] : heavyOpPass(ns, snap, directives);
  if (stasisQueued.length) ops.push(...stasisQueued);

  if (ops.length) {
    try {
      ns.write(PENDING_FILE, JSON.stringify({
        _reqId: String(Date.now()),
        ops: ops.slice(0, MAX_OPS_PER_CYCLE)
      }), "w");
      launchHelper(ns, EXEC_HELPER);
    } catch (_) {}
  }

  // 4) Publish session table for the execute helper + state for AI.
  publishSessions(ns);
  publishState(ns, snapshotToState(snap, { mode, ops, auths }));

  const cha = ns.getPlayer().skills.charisma || 0;
  const neighbourSummary = (snap.servers || []).map((s) =>
    s.host + "[d=" + (s.depth ?? "?") + ",cha=" + (s.requiredCha ?? "?") + ",dn=" + (s.isDarknet ?? "?") + "]"
  ).slice(0, 6).join(" ");
  ns.print("INFO  mode=" + mode +
           " sessions=" + SESSIONS.size +
           " cha=" + cha +
           " neighbors=" + (snap.servers?.length || 0) +
           " stasis=" + (snap.stasis?.used || 0) + "/" + (snap.stasis?.limit || 0) +
           (auths.length ? " auth+" + auths.length : "") +
           (ops.length   ? " ops="   + ops.length   : ""));
  if (neighbourSummary) ns.print("INFO  neighbours: " + neighbourSummary);

  return "m=" + mode +
         " sess=" + SESSIONS.size +
         " sta=" + (snap.stasis?.used || 0) + "/" + (snap.stasis?.limit || 0);
}

// ─── auth pass ───────────────────────────────────────────────────────
async function authenticatePass(ns, snap, directives) {
  const out = [];
  const player = ns.getPlayer();
  const cha = player.skills.charisma || 0;
  const minDepth   = Number(directives.minDepth ?? -1);   // -1 keeps "depth unknown" hosts in play
  const maxDepth   = Number(directives.maxDepth ?? 999);
  const reqList    = Array.isArray(directives.authenticate) ? directives.authenticate : null;
  const ignoreCha  = !!directives.ignoreCharisma;          // override for debugging

  // Index snap.servers by host for cheap lookup of depth/cha.
  const meta = new Map();
  for (const s of (snap.servers || [])) {
    if (s.host) meta.set(s.host, s);
  }

  // Build candidate list from expansion (source -> neighbours). The
  // expansion entry tells us which session to connectToSession before
  // we authenticate a given neighbour. `(current)` means probe from
  // wherever the script is sitting (home) — no preconnect needed.
  // Sources are walked shallowest-first so we crack outward, not random.
  const expansion = (snap.expansion || []).slice();
  expansion.sort((a, b) => {
    const da = meta.get(a.source)?.depth ?? 0;
    const db = meta.get(b.source)?.depth ?? 0;
    return da - db;
  });

  const reasons = [];
  let triedAny = false;

  for (const exp of expansion) {
    if (out.length >= MAX_AUTH_PER_CYCLE) break;
    const source = exp.source;
    const neighbours = exp.neighbours || [];
    if (!neighbours.length) continue;

    // Pre-connect to the source so authenticate() sees the target as adjacent.
    if (source && source !== "(current)" && SESSIONS.has(source)) {
      try { ns.dnet.connectToSession(source, SESSIONS.get(source).password); }
      catch (e) { appendLog(ns, "CONN FAIL " + source + ": " + String(e.message || e)); }
    }

    for (const host of neighbours) {
      if (out.length >= MAX_AUTH_PER_CYCLE) break;
      if (SESSIONS.has(host))                    { reasons.push(host + ":already-authed"); continue; }
      const s = meta.get(host) || { host };
      if (s.isDarknet === false)                 { reasons.push(host + ":not-darknet"); continue; }
      if (typeof s.depth === "number" && s.depth !== -1 && (s.depth < minDepth || s.depth > maxDepth)) {
        reasons.push(host + ":depth=" + s.depth + " out of [" + minDepth + "," + maxDepth + "]");
        continue;
      }
      if (reqList && !reqList.includes(host))    { reasons.push(host + ":not-in-authenticate-list"); continue; }
      if (!ignoreCha && s.requiredCha != null && cha < s.requiredCha) {
        reasons.push(host + ":cha=" + cha + "<req=" + s.requiredCha);
        continue;
      }

      triedAny = true;

      // Resolve auth details: prefer live fetch (isConnectedToCurrentServer is dynamic),
      // fall back to snapshot data.
      const authDetails = fetchAuthDetails(ns, host) || s.auth || {};
      const model = String(authDetails.modelId || authDetails.model || "unknown");

      // The game only allows authenticate() on servers that are directly connected and online.
      if (authDetails.isOnline === false) {
        reasons.push(host + ":offline"); continue;
      }
      if (authDetails.isConnectedToCurrentServer === false) {
        reasons.push(host + ":not-connected"); continue;
      }
      // Skip if this PID already has a session.
      if (authDetails.hasSession) {
        if (!SESSIONS.has(host)) {
          SESSIONS.set(host, { password: "(existing)", openedAt: Date.now(), depth: s.depth, requiredCha: s.requiredCha, model });
          deployCrawler(ns, host);
        }
        reasons.push(host + ":has-session"); continue;
      }

      const pw = solvePassword(authDetails);

      let ok = false;
      try {
        const r = await ns.dnet.authenticate(host, pw, DEFAULT_AUTH_MS);
        // authenticate() returns { success: boolean } — NOT a bare boolean.
        ok = !!(r?.success ?? r);
      } catch (e) {
        appendLog(ns, "AUTH FAIL " + host + " via " + source + " model=" + model + ": " + String(e.message || e));
        ns.print("WARN  authenticate(" + host + ") via " + source + " model=" + model + " threw: " + String(e.message || e));
        continue;
      }
      if (ok) {
        SESSIONS.set(host, {
          password: pw,
          openedAt: Date.now(),
          depth:    s.depth,
          requiredCha: s.requiredCha,
          parent:   source,
          model
        });
        out.push(host);
        appendLog(ns, "AUTH " + host + " via " + source + " model=" + model + " depth=" + s.depth + " cha-req=" + s.requiredCha);
        ns.print("SUCCESS  authenticated " + host + " via " + source + " (model=" + model + ", depth=" + s.depth + ", cha-req=" + s.requiredCha + ")");
        deployCrawler(ns, host);
      } else {
        appendLog(ns, "AUTH FAIL " + host + " via " + source + " model=" + model + " pw-len=" + pw.length);
        ns.print("WARN  authenticate(" + host + ") via " + source + " model=" + model + " FAILED (wrong password model?)");
      }
    }
  }

  if (out.length === 0 && !triedAny) {
    const why = reasons.slice(0, 5).join("; ") || "(no expansion data — snap helper hasn't walked yet)";
    ns.print("INFO  no auth candidates (cha=" + cha + "): " + why);
    appendLog(ns, "NO-CANDIDATES cha=" + cha + " — " + why);
  }
  return out;
}

// ─── stasis link policy ──────────────────────────────────────────────
function stasisPass(ns, snap, directives) {
  const policy = String(directives.stasisPolicy || "deepest").toLowerCase();
  const limit  = Number(snap.stasis?.limit || 0);
  const current = new Set(snap.stasis?.links || []);
  if (limit <= 0) return [];

  let want;
  if (policy === "manual") {
    want = Array.isArray(directives.manualStasis) ? directives.manualStasis.slice(0, limit) : [];
  } else {
    // Default — pin the deepest authenticated servers.
    want = [...SESSIONS.entries()]
      .sort((a, b) => (b[1].depth || 0) - (a[1].depth || 0))
      .slice(0, limit)
      .map(([h]) => h);
  }

  const ops = [];
  for (const h of want) {
    if (current.has(h)) continue;
    try {
      if (ns.dnet.setStasisLink(h)) {
        appendLog(ns, "STASIS+ " + h);
      } else {
        // Couldn't set inline (maybe needs to be done from the execute
        // helper or under a session). Queue it.
        ops.push({ op: "stasis_set", host: h });
      }
    } catch (_) {
      ops.push({ op: "stasis_set", host: h });
    }
  }
  return ops;
}

// ─── heavy op planning ───────────────────────────────────────────────
function heavyOpPass(ns, snap, directives) {
  const explicit = Array.isArray(directives.ops) ? directives.ops : null;
  if (explicit) return explicit.slice(0, MAX_OPS_PER_CYCLE);

  const mode = String(directives.mode || "auto").toLowerCase();
  const ops = [];

  // Always try to free RAM on authenticated hosts that have blocked RAM.
  for (const s of (snap.servers || [])) {
    if (!SESSIONS.has(s.host)) continue;
    if ((s.blockedRam || 0) > 0) {
      ops.push({ op: "memreal", host: s.host });
    }
    if (ops.length >= MAX_OPS_PER_CYCLE) break;
  }

  if (mode === "cha_grind" || mode === "phish") {
    ops.push({ op: "phishing", threads: DEFAULT_PHISH_TH });
  } else if (mode === "explore" || mode === "auto") {
    // Heartbleed peek on shallowest authenticated server for intel.
    const target = [...SESSIONS.entries()]
      .sort((a, b) => (a[1].depth || 0) - (b[1].depth || 0))[0];
    if (target) {
      ops.push({
        op: "heartbleed",
        host: target[0],
        threads: DEFAULT_HEARTBLEED_TH,
        peek: DEFAULT_HEARTBLEED_PEEK
      });
    }
  }

  if (directives.pumpDump && directives.pumpDump.enabled && Array.isArray(directives.pumpDump.symbols)) {
    for (const sym of directives.pumpDump.symbols) {
      ops.push({ op: "pump_dump", symbol: sym, threads: directives.pumpDump.threads || 2 });
      if (ops.length >= MAX_OPS_PER_CYCLE) break;
    }
  }

  if (directives.allowMigration && Array.isArray(directives.migrate)) {
    for (const host of directives.migrate) {
      ops.push({ op: "migrate", host, threads: DEFAULT_MIGRATE_TH });
      if (ops.length >= MAX_OPS_PER_CYCLE) break;
    }
  }

  return ops.slice(0, MAX_OPS_PER_CYCLE);
}

// ─── state / sessions output ─────────────────────────────────────────
function publishSessions(ns) {
  const out = {};
  for (const [host, info] of SESSIONS) out[host] = info.password;
  try {
    ns.write(SESSIONS_FILE, JSON.stringify({
      ts: Date.now(),
      version: "DARKNET_MANAGER_VERSION_5",
      sessions: out
    }), "w");
  } catch (_) {}
}

function snapshotToState(snap, extras) {
  const sessions = [...SESSIONS.entries()].map(([host, info]) => ({
    host, depth: info.depth, requiredCha: info.requiredCha, openedAt: info.openedAt, model: info.model || null
  }));
  return {
    supported: true,
    hasNavigator: !!snap?.hasNavigator,
    instability: snap?.instability ?? null,
    mode: extras?.mode || "auto",
    stasis: snap?.stasis || { used: 0, limit: 0, links: [] },
    neighbors: (snap?.servers || []).map((s) => ({
      host: s.host,
      depth: s.depth,
      requiredCha: s.requiredCha,
      blockedRam: s.blockedRam,
      authed: SESSIONS.has(s.host)
    })),
    sessions,
    queuedOps:  (extras?.ops || []).map((o) => ({ op: o.op, host: o.host || null })),
    newAuths:   extras?.auths || []
  };
}

function publishState(ns, payload) {
  try {
    ns.write(STATE_FILE, JSON.stringify({
      ts: Date.now(),
      version: "DARKNET_MANAGER_VERSION_5",
      ...payload
    }, null, 2), "w");
  } catch (_) {}
}

// ─── helpers ─────────────────────────────────────────────────────────
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

// Deploy the crawler onto a darknet server so it can probe+auth beyond home.
// The crawler is self-replicating — once on one server it spreads itself.
function deployCrawler(ns, host) {
  if (!ns.fileExists(CRAWLER_HELPER, "home")) return;
  try { ns.scp(CRAWLER_HELPER, host); } catch (_) {}
  try {
    ns.exec(CRAWLER_HELPER, host, { preventDuplicates: true });
  } catch (_) {
    try { ns.exec(CRAWLER_HELPER, host, 1); } catch (_) {}
  }
}

// ─── password solver ─────────────────────────────────────────────────
// Derives the correct password from the server's auth model.
// Models observed so far:
//   ZeroLogon — empty string (CVE-2020-1472 namesake; confirmed code:200)
// Unknown models fall back to a random string so the attempt still fires
// and we can log the failure + model for future investigation.
function solvePassword(authDetails) {
  const model = String(authDetails?.modelId || authDetails?.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (model) {
    case "zerologon": return "";
    default:          return "";  // unknown model — send empty and let heartbleed logs reveal the hint
  }
}

// Try to read auth details for a host we haven't snapped yet.
// Returns null if the call fails or produces nothing useful.
function fetchAuthDetails(ns, host) {
  try { return ns.dnet.getServerAuthDetails(host) || null; } catch (_) { return null; }
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
