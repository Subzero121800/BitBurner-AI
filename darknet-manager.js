/**
 * darknet-manager.js — Darknet autopilot
 *
 * DARKNET_MANAGER_VERSION_6
 *
 * v6 changes:
 *   - Fix ZeroLogon password: "0" not "" (empty)
 *   - Full hint-based password solver using passwordHint + data fields
 *   - probeAllSessions(): probe from each PID-owned session each tick
 *     to discover neighbours that are invisible from home
 *   - openCaches(): open .cache files found on authenticated servers
 *   - ns.dnet.nextMutation() called each cycle to advance state machine
 *   - authenticatePass now tries all password candidates per host
 *   - deployCrawler logs exec success/failure instead of silently failing
 *   - liveExpansion from probeAllSessions merged into authenticatePass
 *
 * Architecture:
 *   - /helpers/darknet-snapshot.js  (one-shot: reads game state → snap JSON)
 *   - /helpers/darknet-execute.js   (one-shot: applies heavy ops batch)
 *   - /helpers/darknet-crawler.js   (persistent on each darknet server: probes + spreads)
 *   - darknet-manager.js            (this file — session owner, auth, stasis)
 *
 * Password models (ns.dnet.getServerAuthDetails().modelId):
 *   ZeroLogon  — "0"
 *   (length=0) — "" (empty)
 *   (others)   — derived from passwordHint + data fields
 */

const POLL_MS                  = 30_000;
const DIRECTIVE_STALE_MS       = 10 * 60 * 1000;
const DEFAULT_AUTH_MS          = 0;
const DEFAULT_HEARTBLEED_PEEK  = false;
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
const EXPANSION_FILE  = "/Temp/darknet-expansion.json";

const LOG_FILE      = "/logs/darknet.txt";
const LOG_PREV      = "/logs/darknet.1.txt";
const LOG_MAX_BYTES = 256_000;

// In-process session table — PID-bound. host → { password, openedAt, depth, requiredCha, model }.
const SESSIONS = new Map();

// Per-session Ollama hint-solve cache so we don't re-query the same host.
// host → string[] (candidates), or [] if AI couldn't solve it.
const HINT_CACHE = new Map();

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("INFO  darknet-manager v6 up (hint-based solver + session probe)");
  appendLog(ns, "START darknet-manager v6");

  if (!ns.dnet) {
    ns.print("ERROR  ns.dnet unavailable — game version pre-3.0.0?");
    appendLog(ns, "ABORT ns.dnet unavailable");
    publishState(ns, { supported: false });
    return;
  }

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

  // 0) Probe from home and each owned session to build live expansion data.
  //    connectToSession only works from the PID that owns the session (this one).
  const liveExpansion = await probeAllSessions(ns);

  // 1) Open .cache files found on authenticated servers.
  openCaches(ns);

  // 2) Authentication pass — try to expand session coverage.
  const auths = (mode === "manual") ? [] : await authenticatePass(ns, snap, liveExpansion, directives);

  // 3) Stasis link pass.
  const stasisQueued = stasisPass(ns, snap, directives);

  // 4) Heavy-op queue.
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

  // 5) Publish session table for the execute helper + state for AI.
  publishSessions(ns);
  publishState(ns, snapshotToState(snap, { mode, ops, auths }));

  // 6) nextMutation — advances the darknet state machine each cycle.
  try { await ns.dnet.nextMutation(); } catch (_) {}

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
           (ops.length   ? " ops="  + ops.length   : ""));
  if (neighbourSummary) ns.print("INFO  neighbours: " + neighbourSummary);

  return "m=" + mode +
         " sess=" + SESSIONS.size +
         " sta=" + (snap.stasis?.used || 0) + "/" + (snap.stasis?.limit || 0);
}

// ─── session-aware probe ─────────────────────────────────────────────
// Runs in the manager PID (which owns all sessions) so connectToSession
// actually repositions the probe cursor — this is the key discovery loop.
async function probeAllSessions(ns) {
  const expansion = [];

  // Baseline probe from home.
  try {
    const base = ns.dnet.probe();
    if (Array.isArray(base)) expansion.push({ source: "(current)", neighbours: base });
  } catch (_) {}

  // Per-session: reconnect → probe to see that server's neighbours.
  for (const [host, info] of SESSIONS) {
    try {
      ns.dnet.connectToSession(host, info.password);
      await ns.sleep(0);
      const sp = ns.dnet.probe();
      if (Array.isArray(sp) && sp.length) {
        expansion.push({ source: host, neighbours: sp });
        ns.print("INFO  probe(" + host + ") → " + sp.length + " neighbour(s): " + sp.slice(0, 4).join(", "));
      } else {
        ns.print("INFO  probe(" + host + ") → empty (no adjacent darknet servers)");
      }
    } catch (e) {
      ns.print("WARN  probe(" + host + ") threw: " + String(e.message || e));
    }
  }

  // Write for the snapshot to merge on its next run.
  try {
    ns.write(EXPANSION_FILE, JSON.stringify({ ts: Date.now(), expansion }), "w");
  } catch (_) {}

  return expansion;
}

// ─── cache opening ───────────────────────────────────────────────────
function openCaches(ns) {
  for (const [host] of SESSIONS) {
    try {
      const files = ns.ls(host);
      for (const file of files) {
        if (!file.endsWith(".cache")) continue;
        try {
          const r = ns.dnet.openCache(file);
          if (r) {
            const msg = r.message || String(r);
            ns.print("INFO  cache opened " + file + " on " + host + ": " + msg.slice(0, 120));
            appendLog(ns, "CACHE " + file + " on " + host + ": " + msg.slice(0, 120));
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}

// ─── auth pass ───────────────────────────────────────────────────────
async function authenticatePass(ns, snap, liveExpansion, directives) {
  const out = [];
  const player = ns.getPlayer();
  const cha = player.skills.charisma || 0;
  const minDepth  = Number(directives.minDepth ?? -1);
  const maxDepth  = Number(directives.maxDepth ?? 999);
  const reqList   = Array.isArray(directives.authenticate) ? directives.authenticate : null;
  const ignoreCha = !!directives.ignoreCharisma;

  const meta = new Map();
  for (const s of (snap.servers || [])) {
    if (s.host) meta.set(s.host, s);
  }

  // Merge live expansion (from session probes) with snapshot expansion.
  // UNION neighbours for the same source — connectToSession+probe() from the
  // manager PID often returns only the host itself (e.g. darkweb → ["darkweb"]),
  // so the snap's crawler disc data (the real neighbour list) must not be dropped.
  const expansion = [...liveExpansion];
  for (const e of (snap.expansion || [])) {
    const existing = expansion.find(x => x.source === e.source);
    if (existing) {
      const merged = new Set([...existing.neighbours, ...e.neighbours]);
      existing.neighbours = [...merged];
    } else {
      expansion.push(e);
    }
  }
  // Add labradar-discovered hosts as a synthetic expansion entry so they
  // get attempted even before crawlers walk to them. For this source
  // SESSIONS has no entry, so no pre-connect is attempted — authenticate()
  // will fail for non-adjacent hosts and log a WARN.
  if (Array.isArray(snap.labradar) && snap.labradar.length) {
    const inExpansion = new Set(expansion.flatMap(e => e.neighbours));
    const labOnly = snap.labradar
      .map(h => typeof h === "string" ? h : (h.host || null))
      .filter(h => h && !inExpansion.has(h));
    if (labOnly.length) expansion.push({ source: "(labradar)", neighbours: labOnly });
  }

  expansion.sort((a, b) => {
    const da = meta.get(a.source)?.depth ?? 0;
    const db = meta.get(b.source)?.depth ?? 0;
    return da - db;
  });

  const reasons = [];
  let triedAny = false;
  let ollamaHintUsedThisCycle = false;

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

      const authDetails = fetchAuthDetails(ns, host) || s.auth || {};
      const model = String(authDetails.modelId || authDetails.model || "unknown");

      if (authDetails.isOnline === false) {
        reasons.push(host + ":offline"); continue;
      }
      // isConnectedToCurrentServer: do NOT hard-skip — labradar-discovered hosts
      // report false from home but may still be authenticatable. Let authenticate()
      // return false/throw rather than pre-filtering valid targets.
      if (authDetails.hasSession) {
        if (SESSIONS.has(host)) { reasons.push(host + ":already-owned"); continue; }
        // A crawler PID owns this session — solve the password and re-authenticate
        // so the manager's PID takes ownership (required for connectToSession probing).
        const passwords = solvePasswords(authDetails);
        let reauthed = false;
        for (const pw of passwords) {
          try {
            const r = await ns.dnet.authenticate(host, pw, DEFAULT_AUTH_MS);
            if (!!(r?.success ?? r)) {
              SESSIONS.set(host, { password: pw, openedAt: Date.now(), depth: s.depth, requiredCha: s.requiredCha, parent: source, model });
              out.push(host);
              appendLog(ns, "REAUTH " + host + " via " + source + " (took ownership) model=" + model + " pw=" + JSON.stringify(pw));
              ns.print("SUCCESS  re-authenticated " + host + " (took ownership from crawler, model=" + model + ", pw=" + JSON.stringify(pw) + ")");
              deployCrawler(ns, host);
              reauthed = true;
              break;
            }
          } catch (_) { break; }
        }
        if (!reauthed) {
          SESSIONS.set(host, { password: "(existing)", openedAt: Date.now(), depth: s.depth, requiredCha: s.requiredCha, model });
          deployCrawler(ns, host);
          ns.print("INFO  accepted crawler session on " + host + " (no pw candidates for re-auth, model=" + model + ")");
        }
        continue;
      }

      let passwords = solvePasswords(authDetails);
      if (!passwords.length && !ollamaHintUsedThisCycle) {
        passwords = await askOllamaForHint(ns, host, authDetails);
        if (passwords.length) ollamaHintUsedThisCycle = true;
      }
      if (!passwords.length) {
        const hint = String(authDetails.passwordHint || "(none)").slice(0, 80);
        reasons.push(host + ":no-pw-candidates");
        appendLog(ns, "SKIP " + host + " model=" + model + " hint=" + hint + " — no candidates");
        ns.print("INFO  skip " + host + " model=" + model + " — no candidates (hint: " + hint + ")");
        continue;
      }

      let ok = false;
      let successPw = null;
      for (const pw of passwords) {
        if (ok) break;
        try {
          const r = await ns.dnet.authenticate(host, pw, DEFAULT_AUTH_MS);
          if (!!(r?.success ?? r)) { ok = true; successPw = pw; }
        } catch (e) {
          appendLog(ns, "AUTH ERR " + host + " pw=" + JSON.stringify(pw) + ": " + String(e.message || e));
          break;
        }
      }

      if (ok) {
        SESSIONS.set(host, {
          password:    successPw,
          openedAt:    Date.now(),
          depth:       s.depth,
          requiredCha: s.requiredCha,
          parent:      source,
          model
        });
        out.push(host);
        appendLog(ns, "AUTH " + host + " via " + source + " model=" + model + " pw=" + JSON.stringify(successPw));
        ns.print("SUCCESS  authenticated " + host + " via " + source +
                 " (model=" + model + ", pw=" + JSON.stringify(successPw) + ", depth=" + s.depth + ")");
        deployCrawler(ns, host);
      } else {
        appendLog(ns, "AUTH FAIL " + host + " model=" + model + " tried=" + passwords.length + " candidates");
        ns.print("WARN  authenticate(" + host + ") via " + source + " model=" + model +
                 " — all " + passwords.length + " candidate(s) failed");
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

  for (const s of (snap.servers || [])) {
    if (!SESSIONS.has(s.host)) continue;
    if ((s.blockedRam || 0) > 0) ops.push({ op: "memreal", host: s.host });
    if (ops.length >= MAX_OPS_PER_CYCLE) break;
  }

  if (mode === "cha_grind" || mode === "phish") {
    ops.push({ op: "phishing", threads: DEFAULT_PHISH_TH });
  } else if (mode === "explore" || mode === "auto") {
    const target = [...SESSIONS.entries()]
      .sort((a, b) => (a[1].depth || 0) - (b[1].depth || 0))[0];
    if (target) {
      ops.push({
        op:      "heartbleed",
        host:    target[0],
        threads: DEFAULT_HEARTBLEED_TH,
        peek:    DEFAULT_HEARTBLEED_PEEK
      });
    }
  }

  if (directives.pumpDump?.enabled && Array.isArray(directives.pumpDump.symbols)) {
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
      version: "DARKNET_MANAGER_VERSION_6",
      sessions: out
    }), "w");
  } catch (_) {}
}

function snapshotToState(snap, extras) {
  const sessions = [...SESSIONS.entries()].map(([host, info]) => ({
    host, depth: info.depth, requiredCha: info.requiredCha, openedAt: info.openedAt, model: info.model || null
  }));
  return {
    supported:    true,
    hasNavigator: !!snap?.hasNavigator,
    instability:  snap?.instability ?? null,
    mode:         extras?.mode || "auto",
    stasis:       snap?.stasis || { used: 0, limit: 0, links: [] },
    neighbors: (snap?.servers || []).map((s) => ({
      host: s.host, depth: s.depth, requiredCha: s.requiredCha,
      blockedRam: s.blockedRam, authed: SESSIONS.has(s.host)
    })),
    sessions,
    queuedOps: (extras?.ops || []).map((o) => ({ op: o.op, host: o.host || null })),
    newAuths:  extras?.auths || []
  };
}

function publishState(ns, payload) {
  try {
    ns.write(STATE_FILE, JSON.stringify({
      ts: Date.now(),
      version: "DARKNET_MANAGER_VERSION_6",
      ...payload
    }, null, 2), "w");
  } catch (_) {}
}

// ─── password solver ─────────────────────────────────────────────────
function primesOfLength(digits) {
  const lo = digits <= 1 ? 2 : Math.pow(10, digits - 1);
  const hi = Math.pow(10, digits);
  const sieve = new Uint8Array(hi).fill(1);
  sieve[0] = sieve[1] = 0;
  for (let i = 2; i * i < hi; i++) if (sieve[i]) for (let j = i * i; j < hi; j += i) sieve[j] = 0;
  const out = [];
  for (let i = lo; i < hi; i++) if (sieve[i]) out.push(String(i));
  return out;
}

// Returns an ordered array of password candidates based on auth details.
// The caller tries each in sequence and stops on the first success.
function solvePasswords(authDetails) {
  // No password (length 0 = empty string required).
  if ((authDetails.passwordLength ?? -1) === 0) return [""];

  const model = String(authDetails.modelId || authDetails.model || "");
  if (model === "ZeroLogon") return ["0"];
  if (model === "Factori-Os") return primesOfLength(authDetails.passwordLength || 3);
  if (model === "Pr0verFl0") {
    const len = authDetails.passwordLength || 5;
    const fill = (c) => c.repeat(len);
    return [fill("a"), fill("A"), fill("x"), "admin", "guest", "login", "letme", "enter"].filter(s => s.length === len);
  }

  const hint  = String(authDetails.passwordHint || "").toLowerCase();
  const data  = String(authDetails.data || "");
  const words = hint.split(/\s+/).filter(Boolean);

  if (!hint) return [];   // no hint — can't derive password

  if (words.some(w => ["default", "factory", "never"].includes(w))) {
    return ["0000", "12345", "admin", "password"];
  }

  // "The password is <number>" — last token is the number.
  if (data === "" && words.length && !isNaN(words.at(-1))) {
    return [words.at(-1)];
  }

  if (words.includes("human")) {
    let pw = "";
    for (const c of data) if (!isNaN(c) && c !== " ") pw += c;
    return pw ? [pw] : [];
  }

  if (words.some(w => ["made", "sorted", "shuffled", "uses"].includes(w))) {
    const d = data.slice(0, 3);
    if (!d) return [];
    if (d.length <= 1) return [d];
    const perms = new Set([data]);
    for (let a = 0; a < d.length; a++)
      for (let b = 0; b < d.length; b++)
        for (let c = 0; c < d.length; c++)
          if (a !== b && b !== c && a !== c) perms.add(d[a] + d[b] + d[c]);
    return [...perms];
  }

  if (words.includes("buffer")) {
    const len = authDetails.passwordLength || 5;
    const fill = (c) => c.repeat(len);
    return [fill("a"), fill("A"), fill("x"), "admin", "guest", "login", "letme", "enter"].filter(s => s.length === len);
  }

  if (words.includes("dog")) return ["fido", "spot", "rover", "max"];

  if (words.includes("value")) {
    const roman = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let val = 0;
    for (let i = 0; i < data.length; i++) {
      const cur = roman[data[i]] || 0;
      const nxt = roman[data[i + 1]] || 0;
      val += cur < nxt ? -cur : cur;
    }
    return [String(val)];
  }

  if (words.includes("base")) {
    try {
      const parts = data.split(",");
      return [String(parseInt(parts[1].trim(), parseInt(parts[0].trim())))];
    } catch (_) { return []; }
  }

  if (words.includes("between")) {
    const nums = words.filter(w => !isNaN(w) && w !== "").map(Number);
    if (nums.length >= 2) {
      const lo = Math.min(...nums) + 1;
      const hi = Math.max(...nums);
      const candidates = [];
      for (let i = lo; i < hi; i++) { candidates.push(String(i)); if (candidates.length >= 50) break; }
      return candidates;
    }
    return [];
  }

  if (words.includes("divisible")) {
    const len = authDetails.passwordLength || 4;
    const rawHint = String(authDetails.passwordHint || "");
    if (rawHint.includes(";)") || rawHint.includes(":)")) return primesOfLength(len);
    const byIdx = words.indexOf("by");
    const divisor = byIdx >= 0 ? parseInt(words[byIdx + 1]) : NaN;
    if (!isNaN(divisor) && divisor > 1) {
      const lo = Math.ceil(Math.pow(10, len - 1) / divisor) * divisor;
      const hi = Math.pow(10, len);
      const candidates = [];
      for (let i = lo; i < hi; i += divisor) { candidates.push(String(i)); if (candidates.length >= 100) break; }
      return candidates;
    }
    const lo = len <= 1 ? 1 : Math.pow(10, len - 1);
    const candidates = [];
    for (let i = lo; i < Math.pow(10, len); i++) { candidates.push(String(i)); if (candidates.length >= 100) break; }
    return candidates;
  }

  return [];   // unknown hint — log from caller
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

// Deploy the self-replicating crawler onto a darknet server.
// The crawler calls probe() from that server's position, authenticates its
// neighbours, and spreads itself further — building out the topology map.
function deployCrawler(ns, host) {
  if (!ns.fileExists(CRAWLER_HELPER, "home")) return;
  try { ns.scp(CRAWLER_HELPER, host, "home"); } catch (_) {}
  let pid = 0;
  try { pid = ns.exec(CRAWLER_HELPER, host, { preventDuplicates: true, threads: 1 }); } catch (_) {}
  if (!pid) {
    try { pid = ns.exec(CRAWLER_HELPER, host, 1); } catch (_) {}
  }
  if (pid > 0) ns.print("INFO  crawler deployed on " + host + " (pid=" + pid + ")");
  else         ns.print("WARN  crawler exec failed on " + host + " (darknet server may not support exec)");
}

function fetchAuthDetails(ns, host) {
  try { return ns.dnet.getServerAuthDetails(host) || null; } catch (_) { return null; }
}

// ─── Ollama hint solver ───────────────────────────────────────────────
// Queries the configured Ollama endpoint (same host as ollama-player) with a
// focused prompt and returns password candidates. Routes through ai-fetch.js so
// the manager doesn't carry the fetch RAM cost. Returns [] on any failure.
async function askOllamaForHint(ns, host, authDetails) {
  if (HINT_CACHE.has(host)) return HINT_CACHE.get(host);

  const helper = "/helpers/ai-fetch.js";
  if (!ns.fileExists(helper, "home")) {
    ns.print("WARN  ai-fetch.js missing — Ollama hint solve skipped for " + host);
    HINT_CACHE.set(host, []);
    return [];
  }

  // Read Ollama endpoint from the player state (written by ollama-player.js each cycle).
  let ollamaBase = "http://127.0.0.1:11434";
  let ollamaModel = "llama3.2:3b";
  try {
    const hostTxt = ns.fileExists("/Temp/ollama-host.txt", "home")
      ? String(ns.read("/Temp/ollama-host.txt") || "").trim() : "";
    if (hostTxt) ollamaBase = hostTxt;
    const pState = JSON.parse(ns.read("/Temp/ollama-player-state.json") || "{}");
    if (pState.ollamaModel) ollamaModel = pState.ollamaModel;
  } catch (_) {}

  const hint   = String(authDetails.passwordHint   || "(none)");
  const format = String(authDetails.passwordFormat || authDetails.format || "unknown");
  const len    = authDetails.passwordLength ?? "unknown";
  const mdl    = String(authDetails.modelId || authDetails.model || "unknown");
  const data   = String(authDetails.data || "");

  const prompt = [
    "You are solving a Bitburner game darknet password puzzle.",
    "Reply with ONLY the password — no explanation, no quotes, no markdown.",
    "",
    "Server model: " + mdl,
    "Format: " + format,
    "Length: " + len,
    "Hint: " + hint,
    (data ? "Data field: " + data : ""),
    "",
    "Password:"
  ].filter(Boolean).join("\n");

  const reqId = "dn-hint-" + Date.now();
  const url   = ollamaBase.replace(/\/$/, "") + "/api/generate";
  const body  = JSON.stringify({
    model:   ollamaModel,
    prompt,
    stream:  false,
    options: { temperature: 0.1, num_ctx: 512 }
  });

  ns.write("/Temp/ai-fetch-req.json", JSON.stringify({
    _reqId: reqId, url, method: "POST",
    headers: { "Content-Type": "application/json" },
    body, timeoutMs: 15_000
  }), "w");

  const pid = ns.exec(helper, "home", 1);
  if (pid <= 0) {
    ns.print("WARN  ai-fetch exec failed for hint solve (" + host + ")");
    HINT_CACHE.set(host, []);
    return [];
  }

  // Poll up to 16 s in 200 ms slices.
  for (let i = 0; i < 80; i++) {
    await ns.sleep(200);
    if (!ns.fileExists("/Temp/ai-fetch-res.json", "home")) continue;
    try {
      const res = JSON.parse(ns.read("/Temp/ai-fetch-res.json") || "{}");
      if (res._reqId !== reqId) continue;
      if (!res.ok) break;
      const raw = (JSON.parse(res.text || "{}").response || "").trim();
      const pw  = raw.split("\n")[0].trim().replace(/^["'`]|["'`]$/g, "");
      const candidates = pw ? [pw] : [];
      HINT_CACHE.set(host, candidates);
      ns.print("INFO  Ollama hint-solve " + host + " model=" + mdl +
               " → " + JSON.stringify(pw) + " (hint: " + hint.slice(0, 60) + ")");
      appendLog(ns, "OLLAMA-HINT " + host + " model=" + mdl + " → " + JSON.stringify(pw));
      return candidates;
    } catch (_) {}
  }

  ns.print("WARN  Ollama hint-solve timed out for " + host);
  HINT_CACHE.set(host, []);
  return [];
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
