/**
 * scb-watch.js — local file watcher / hot-reload daemon
 *
 * Third leg of the local services trio (filesync :12525, bridge :3000,
 * watcher). Started by `./scb.sh start` alongside the other two.
 *
 * What it does:
 *   1. Watches a small allowlist of source files. On edit, writes
 *      /Temp/scb-restart.txt with a fresh timestamp. filesync pushes
 *      that to the game; the in-game scb-watchdog.js reads it and
 *      runs `kill scb.js` + `run scb.js`.
 *   2. On edits to bridge/claude-bridge.js or bridge/.env, restarts
 *      the local bridge process directly.
 *   3. Writes /Temp/scb-heartbeat.txt every 2s. The in-game watchdog
 *      uses staleness on this file to detect Remote API disconnects.
 *   4. Tails .run/sync.log for `Connection made!` / disconnect events
 *      and probes the bridge's /healthz, then writes a one-line status
 *      snapshot to .run/watch.log every 5s.
 *
 * Zero npm deps. Pure Node stdlib.
 */

const fs   = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT     = path.resolve(__dirname, "..");
const RUN_DIR  = path.join(ROOT, ".run");
const TEMP_DIR = path.join(ROOT, "Temp");
const SYNC_LOG = path.join(RUN_DIR, "sync.log");
const WATCH_LOG = path.join(RUN_DIR, "watch.log");
const BRIDGE_PID_FILE = path.join(RUN_DIR, "bridge.pid");

const RESTART_MARKER   = path.join(TEMP_DIR, "scb-restart.txt");
const HEARTBEAT_MARKER = path.join(TEMP_DIR, "scb-heartbeat.txt");
const OLLAMA_HOST_FILE = path.join(TEMP_DIR, "ollama-host.txt");

// Ollama endpoint candidates, probed in order. First one to respond
// wins and gets written to /Temp/ollama-host.txt for the in-game
// player to read on each cycle.
//
// To add LAN endpoints (Jetson, second box, etc.), drop a file at
// watch/ollama-candidates.json containing a JSON array of base URLs:
//   ["http://127.0.0.1:11434", "http://10.0.0.42:11434"]
// That file is gitignored so your network topology stays local.
function loadOllamaCandidates() {
  const cfg = path.join(__dirname, "ollama-candidates.json");
  try {
    if (fs.existsSync(cfg)) {
      const arr = JSON.parse(fs.readFileSync(cfg, "utf8"));
      if (Array.isArray(arr) && arr.every(s => typeof s === "string")) return arr;
    }
  } catch (e) { /* fall through to default */ }
  return ["http://127.0.0.1:11434"];
}
const OLLAMA_CANDIDATES = loadOllamaCandidates();
const OLLAMA_PROBE_MS    = 5 * 60 * 1000; // re-probe every 5 minutes
const OLLAMA_TIMEOUT_MS  = 1500;

// Files whose changes should force the in-game scb.js to restart.
const GAME_FILES = [
  "scb.js",
  "ollama-actions.js",
  "ollama-player.js",
];

// Files whose changes should restart the local bridge process.
const BRIDGE_FILES = [
  "bridge/claude-bridge.js",
  "bridge/.env",
];

const DEBOUNCE_MS    = 500;
const HEARTBEAT_MS   = 2000;
const STATUS_MS      = 5000;
const BRIDGE_PORT    = Number(process.env.PORT || 3000);
const SINK_PORT      = Number(process.env.SCB_SINK_PORT || 9999);
const SINK_NAMES     = new Set(["scb", "ollama-player", "gang", "bladeburner", "sleeve"]);
const SINK_MAX_BYTES = 1_000_000;
const SYNC_TAIL_BYTES = 4096; // how much of sync.log to look at for state

fs.mkdirSync(RUN_DIR,  { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── logging ────────────────────────────────────────────────────────
// scb.sh redirects our stdout to .run/watch.log, so writing once is
// enough — appending directly would double every line.
function logLine(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

// ─── restart marker (for in-game watchdog) ───────────────────────────
let pendingRestart = null;
function bumpRestartMarker(reason) {
  if (pendingRestart) clearTimeout(pendingRestart);
  pendingRestart = setTimeout(() => {
    pendingRestart = null;
    const stamp = `${Date.now()} ${reason}\n`;
    try {
      fs.writeFileSync(RESTART_MARKER, stamp);
      logLine(`restart-marker bumped (${reason})`);
    } catch (e) {
      logLine(`ERROR write restart-marker: ${e.message}`);
    }
  }, DEBOUNCE_MS);
}

// ─── bridge restart ──────────────────────────────────────────────────
let pendingBridge = null;
function restartBridge(reason) {
  if (pendingBridge) clearTimeout(pendingBridge);
  pendingBridge = setTimeout(() => {
    pendingBridge = null;
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(BRIDGE_PID_FILE, "utf8").trim(), 10); }
    catch (_) {}
    if (pid > 0) {
      try { process.kill(pid, "SIGTERM"); }
      catch (e) { logLine(`bridge SIGTERM failed (already dead?): ${e.message}`); }
    }
    setTimeout(() => {
      const child = spawn(path.join(ROOT, "scb.sh"), ["bridge"], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      logLine(`bridge restarted (${reason})`);
    }, 800);
  }, DEBOUNCE_MS);
}

// ─── file watcher ────────────────────────────────────────────────────
// fs.watch is low-latency but unreliable across platforms (FSEvents
// drops some atomic-rename writes on macOS; some editors save with
// patterns that bypass it). We pair it with a 1 s mtime poll so a
// missed event still gets caught within a second.
//
// `selfTouchedMtimes` tracks mtimes we wrote ourselves (via the
// post-detect `touch` below) so we don't re-fire on our own writes.
const selfTouchedMtimes = new Map(); // abs path -> mtimeMs

function watchFile(rel, onChange, { tickleAfter = false } = {}) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    logLine(`watch skip — missing: ${rel}`);
    return;
  }
  let lastMtime = 0;
  try { lastMtime = fs.statSync(abs).mtimeMs; } catch (_) {}

  function check(source) {
    let m = 0;
    try { m = fs.statSync(abs).mtimeMs; } catch (_) { return; }
    if (m === lastMtime) return;
    if (selfTouchedMtimes.get(abs) === m) {
      selfTouchedMtimes.delete(abs);
      lastMtime = m;
      return;
    }
    lastMtime = m;
    onChange(rel, abs);
    if (tickleAfter) {
      // chokidar in bitburner-filesync sometimes drops events from
      // editor-style atomic writes. Force a fresh mtime so it sees a
      // change it can't miss, and remember the mtime so our own
      // watcher ignores the resulting event.
      setTimeout(() => {
        try {
          const t = Date.now() / 1000;
          fs.utimesSync(abs, t, t);
          const stat = fs.statSync(abs);
          selfTouchedMtimes.set(abs, stat.mtimeMs);
          lastMtime = stat.mtimeMs;
        } catch (e) {
          logLine(`tickle failed for ${rel}: ${e.message}`);
        }
      }, 50);
    }
  }

  try { fs.watch(abs, () => check("fs.watch")); }
  catch (e) { logLine(`fs.watch failed for ${rel}: ${e.message}`); }
  setInterval(() => check("poll"), 1000);
  logLine(`watching ${rel}${tickleAfter ? " (with filesync tickle)" : ""}`);
}

for (const f of GAME_FILES)   watchFile(f, (rel) => bumpRestartMarker(rel), { tickleAfter: true });
for (const f of BRIDGE_FILES) watchFile(f, (rel) => restartBridge(rel));

// ─── heartbeat (for in-game disconnect detection) ─────────────────────
setInterval(() => {
  try { fs.writeFileSync(HEARTBEAT_MARKER, String(Date.now())); }
  catch (e) { logLine(`ERROR heartbeat: ${e.message}`); }
}, HEARTBEAT_MS);

// ─── Ollama host detection ──────────────────────────────────────────
// Probe each candidate's /api/tags (a cheap HEAD-equivalent that
// every Ollama server exposes). First responder wins. Re-probed every
// 5 minutes so a Jetson coming online mid-session is picked up.
function probeOllama(baseUrl) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(baseUrl + "/api/tags"); }
    catch (_) { return resolve(false); }
    const req = http.request({
      host: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      method: "GET",
      timeout: OLLAMA_TIMEOUT_MS,
      headers: { "User-Agent": "scb-watch" },
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

let lastOllamaHost = "";
async function detectOllamaHost() {
  for (const candidate of OLLAMA_CANDIDATES) {
    if (await probeOllama(candidate)) {
      if (candidate !== lastOllamaHost) {
        try {
          fs.writeFileSync(OLLAMA_HOST_FILE, candidate);
          logLine(`ollama detected: ${candidate}`);
          lastOllamaHost = candidate;
        } catch (e) {
          logLine(`ERROR write ollama-host: ${e.message}`);
        }
      }
      return;
    }
  }
  if (lastOllamaHost !== "(none)") {
    try {
      // Empty file = no Ollama reachable. Player will fall back on
      // its hard-coded config and probably retry next cycle.
      fs.writeFileSync(OLLAMA_HOST_FILE, "");
      logLine(`ollama: no candidate reachable (${OLLAMA_CANDIDATES.join(", ")})`);
      lastOllamaHost = "(none)";
    } catch (_) {}
  }
}

// Initial probe + periodic re-probe.
detectOllamaHost();
setInterval(detectOllamaHost, OLLAMA_PROBE_MS);

// ─── log sink ───────────────────────────────────────────────────────
// In-game scripts POST log content to http://127.0.0.1:9999/sink/{name}
// and we append the body to .run/game-{name}.log so the host has a
// durable, tail-able copy. Bound to localhost only — no LAN exposure.
const DL_DIR = path.join(RUN_DIR, "downloaded");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":          "*",
  "Access-Control-Allow-Methods":         "POST, OPTIONS",
  "Access-Control-Allow-Headers":         "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

const sinkServer = http.createServer((req, res) => {
  // Browser preflight for cross-origin fetch() from the game
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS); res.end(); return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, CORS_HEADERS); res.end("method not allowed"); return;
  }

  // ── /dl  — receive a game file and write it under .run/downloaded/ ──
  if (req.url === "/dl") {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > SINK_MAX_BYTES) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (total > SINK_MAX_BYTES) { res.writeHead(413, CORS_HEADERS); res.end("too large"); return; }
      try {
        const { path: gamePath, content } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof gamePath !== "string" || gamePath.length === 0) throw new Error("missing path");
        // Prevent path traversal: strip leading slash, collapse any ../
        const safe = gamePath.replace(/\\/g, "/").replace(/\.\./g, "").replace(/^\/+/, "");
        if (!safe) throw new Error("empty path after sanitise");
        const dest = path.join(DL_DIR, safe);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content || "");
        res.writeHead(200, CORS_HEADERS); res.end("ok");
      } catch (e) {
        logLine("dl write failed: " + e.message);
        res.writeHead(500, CORS_HEADERS); res.end(e.message);
      }
    });
    req.on("error", () => { try { res.writeHead(400, CORS_HEADERS); res.end(); } catch (_) {} });
    return;
  }

  // ── /sink/<name>  — append game log line to .run/game-<name>.log ───
  if (!req.url.startsWith("/sink/")) {
    res.writeHead(404); res.end("not found"); return;
  }
  const name = req.url.slice("/sink/".length).replace(/[^a-z0-9_-]/gi, "");
  if (!SINK_NAMES.has(name)) {
    res.writeHead(403); res.end("unknown sink: " + name); return;
  }
  let total = 0;
  const chunks = [];
  req.on("data", (c) => {
    total += c.length;
    if (total > SINK_MAX_BYTES) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (total > SINK_MAX_BYTES) {
      res.writeHead(413); res.end("too large"); return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (!body) { res.writeHead(204); res.end(); return; }
    try {
      fs.appendFileSync(path.join(RUN_DIR, "game-" + name + ".log"), body);
      res.writeHead(200); res.end("ok " + body.length);
    } catch (e) {
      logLine("sink write failed (" + name + "): " + e.message);
      res.writeHead(500); res.end(e.message);
    }
  });
  req.on("error", () => { try { res.writeHead(400); res.end(); } catch (_) {} });
});
sinkServer.listen(SINK_PORT, "127.0.0.1", () => {
  logLine("sink listening on 127.0.0.1:" + SINK_PORT + " (/sink/<name>, /dl)");
});

// ─── status snapshot ─────────────────────────────────────────────────
function readSyncTail() {
  try {
    const stat = fs.statSync(SYNC_LOG);
    const len  = Math.min(stat.size, SYNC_TAIL_BYTES);
    const fd   = fs.openSync(SYNC_LOG, "r");
    const buf  = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch (_) { return ""; }
}

// Persistent connection state.
// `bitburner-filesync` logs `Connection made!` on connect and
// `Connection closed.` / `disconnect` on drop, but ALSO logs every
// "X changed" line whenever a watched file's mtime updates (which
// includes our 2-second heartbeat). Within a minute that fills the
// tail buffer and the original connect event scrolls out — leaving
// us unable to distinguish "connected, still working" from "we never
// saw an event." The fix is to remember what we've already seen
// across status ticks rather than re-deriving from the tail each time.
let _connState = { kind: "unknown", at: 0 };

function syncConnectionState() {
  const tail = readSyncTail();
  const lastConnect    = tail.lastIndexOf("Connection made");
  const lastDisconnect = Math.max(
    tail.lastIndexOf("Connection closed"),
    tail.lastIndexOf("disconnect"),
  );

  if (lastConnect >= 0 && lastConnect > lastDisconnect) {
    if (_connState.kind !== "connected") {
      _connState = { kind: "connected", at: Date.now() };
      logLine("filesync connect event observed");
    }
  } else if (lastDisconnect >= 0 && lastDisconnect > lastConnect) {
    if (_connState.kind !== "disconnected") {
      _connState = { kind: "disconnected", at: Date.now() };
      logLine("filesync DISCONNECT event observed");
    }
  }
  // No event visible in this tail snapshot? Keep the last known
  // state — connected stays connected until we see a closed event.
  return _connState.kind;
}

function probeBridge() {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: BRIDGE_PORT, path: "/healthz",
      method: "GET", timeout: 1500,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? "ok" : `http-${res.statusCode}`);
    });
    req.on("error", () => resolve("down"));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
    req.end();
  });
}

// macOS notification helper. Best-effort; quietly no-ops on non-Darwin.
let lastNotifyAt = 0;
function notifyMac(title, message) {
  if (process.platform !== "darwin") return;
  // Throttle: at most one notification every 5 minutes per kind so
  // we don't spam Notification Center while the WS is flapping.
  if (Date.now() - lastNotifyAt < 5 * 60 * 1000) return;
  lastNotifyAt = Date.now();
  try {
    const escTitle = String(title).replace(/"/g, '\\"');
    const escMsg   = String(message).replace(/"/g, '\\"');
    spawn("osascript", [
      "-e", `display notification "${escMsg}" with title "${escTitle}" sound name "Funk"`
    ], { stdio: "ignore", detached: true }).unref();
  } catch (_) {}
}

let lastStatus = "";
let disconnectedSince = 0;
setInterval(async () => {
  const sync   = syncConnectionState();
  const bridge = await probeBridge();
  const ollama = lastOllamaHost || "(probing)";
  const line   = `status filesync=${sync} bridge=${bridge} ollama=${ollama}`;
  if (line !== lastStatus) {
    logLine(line);
    lastStatus = line;
  }

  // Notify only on CONFIRMED disconnect (a Connection closed event
  // was observed). "unknown" — the tail rolled past the connect
  // event before we ever saw it — is silenced; assume the user
  // knows what they're doing if they explicitly clicked Connect.
  if (sync === "disconnected") {
    if (disconnectedSince === 0) disconnectedSince = Date.now();
    if (Date.now() - disconnectedSince > 60_000) {
      notifyMac(
        "BitBurner-AI: Remote API offline",
        "filesync saw a disconnect event 60s+ ago. Open Bitburner → Options → Remote API → Connect (and tick Auto-connect on Start)."
      );
    }
  } else {
    if (disconnectedSince > 0) logLine("filesync recovered after " + Math.round((Date.now() - disconnectedSince) / 1000) + "s");
    disconnectedSince = 0;
  }
}, STATUS_MS);

// ─── lifecycle ───────────────────────────────────────────────────────
process.on("SIGTERM", () => { logLine("SIGTERM, exiting"); process.exit(0); });
process.on("SIGINT",  () => { logLine("SIGINT, exiting");  process.exit(0); });

logLine(`scb-watch up — root=${ROOT}`);
logLine(`game-files=${GAME_FILES.join(",")} bridge-files=${BRIDGE_FILES.join(",")}`);

// Seed initial heartbeat + restart marker so in-game watchdog has
// something to read on first launch (otherwise it would treat the
// missing file as "disconnected" forever).
fs.writeFileSync(HEARTBEAT_MARKER, String(Date.now()));
if (!fs.existsSync(RESTART_MARKER)) {
  fs.writeFileSync(RESTART_MARKER, `${Date.now()} initial\n`);
}
