/**
 * watch/sync-smart.js — content-hash-driven smart sync
 *
 * Scans all game-bound files (.js / .script / .txt), compares each
 * file's SHA-256 against the last-pushed hash stored in
 * .run/sync-hashes.json, and only `touch`es (= triggers filesync push)
 * the files whose content actually changed.
 *
 * This means scb.js / ollama-player.js etc. are NOT touched unless they
 * really differ on disk — so the in-game watchdog won't restart scb.js
 * for nothing and unchanged helpers won't be re-pushed.
 *
 * Usage (called by scb.sh sync-smart):
 *   node watch/sync-smart.js [--force]
 *
 *   --force   ignore stored hashes and push everything (same as sync-all
 *             but updates the hash store so subsequent runs are smart)
 */

const fs      = require("node:fs");
const path    = require("node:path");
const crypto  = require("node:crypto");

const ROOT      = path.resolve(__dirname, "..");
const RUN_DIR   = path.join(ROOT, ".run");
const HASH_FILE = path.join(RUN_DIR, "sync-hashes.json");

const FORCE = process.argv.includes("--force");

// Same exclusions as sync-all in scb.sh.
const EXCLUDE_DIRS = new Set([
  "node_modules", ".run", "bridge", "watch",
  ".vscode", "Temp", ".git", "Deprecated", "_archive", "docs",
]);

const EXTS = new Set([".js", ".script", ".txt"]);

// ── helpers ───────────────────────────────────────────────────────────

function sha256(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch (_) {
    return null;
  }
}

function touchFile(filePath) {
  const now = Date.now() / 1000;
  fs.utimesSync(filePath, now, now);
}

function loadHashes() {
  try {
    if (fs.existsSync(HASH_FILE)) {
      return JSON.parse(fs.readFileSync(HASH_FILE, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveHashes(hashes) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2));
}

function scanFiles(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return results; }

  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".vscode") {
      // allow dotfiles at root level to be excluded by name, skip hidden dirs
      if (e.isDirectory()) continue;
    }
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs);

    if (e.isDirectory()) {
      const topDir = rel.split(path.sep)[0];
      if (EXCLUDE_DIRS.has(topDir)) continue;
      scanFiles(abs, results);
    } else if (e.isFile()) {
      const topDir = rel.split(path.sep)[0];
      if (EXCLUDE_DIRS.has(topDir)) continue;
      if (EXTS.has(path.extname(e.name))) results.push(abs);
    }
  }
  return results;
}

// ── main ──────────────────────────────────────────────────────────────

const hashes = FORCE ? {} : loadHashes();
const files  = scanFiles(ROOT);

let pushed = 0, skipped = 0, failed = 0;
const changed = [];

for (const abs of files) {
  const rel  = path.relative(ROOT, abs);
  const hash = sha256(abs);
  if (hash === null) { failed++; continue; }

  if (!FORCE && hashes[rel] === hash) {
    skipped++;
    continue;
  }

  try {
    touchFile(abs);
    hashes[rel] = hash;
    pushed++;
    changed.push(rel);
  } catch (e) {
    console.error(`WARN  touch failed for ${rel}: ${e.message}`);
    failed++;
  }
}

saveHashes(hashes);

// Output one line per changed file so scb.sh can log/count them.
for (const f of changed) console.log(`push  ${f}`);

// Final summary on stderr so scb.sh can capture stdout for the file list.
process.stderr.write(
  `sync-smart: ${pushed} pushed, ${skipped} skipped, ${failed} failed` +
  (FORCE ? " (--force)" : "") + "\n"
);
