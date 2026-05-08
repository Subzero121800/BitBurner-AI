/**
 * /ai/dispatch/fs.js — filesystem & process control
 * DISPATCH_FS_VERSION_1
 *
 * One-shot. read_file, list_files, write_generated_script,
 * delete_generated_script, run_script, kill_script, copy_script,
 * propose_patch. Static RAM ~ 6 GB (ns.rm + ns.kill + ns.ps +
 * ns.scp + ns.exec + ns.ls + ns.toast + read/write/fileExists).
 *
 * Same allowlist + path traversal protection as the original
 * ollama-actions.js. PROTECTED files require propose_patch.
 */

const REQ = "/Temp/ai-action-req.json";
const RES = "/Temp/ai-action-res.json";

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

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let a;
  try { a = JSON.parse(ns.read(REQ)); }
  catch (e) { return writeRes(ns, fail("bad request: " + String(e))); }

  let res;
  try {
    switch (a.action) {
      case "read_file":               res = readFile(ns, a); break;
      case "list_files":              res = listFiles(ns, a); break;
      case "write_generated_script":  res = writeGen(ns, a); break;
      case "delete_generated_script": res = deleteGen(ns, a); break;
      case "run_script":              res = runScript(ns, a); break;
      case "kill_script":             res = killScript(ns, a); break;
      case "copy_script":             res = copyScript(ns, a); break;
      case "propose_patch":           res = proposePatch(ns, a); break;
      default: res = fail("fs: unknown action " + a.action);
    }
  } catch (e) { res = fail("fs threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

function normPath(p) {
  if (!p) return "";
  let s = String(p).trim();
  if (!s) return "";
  if (!s.startsWith("/")) s = "/" + s;
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
  return WRITE_ALLOWED_PREFIXES.some((pre) => n.startsWith(pre));
}

function readFile(ns, a) {
  const p = normPath(a.path);
  if (!p) return fail("read_file: missing path");
  if (!ns.fileExists(p, "home")) return fail("read_file: not found: " + p);
  const c = ns.read(p);
  const max = 4000;
  const trunc = c.length > max;
  const body = trunc ? c.slice(0, max) + "\n...[truncated " + (c.length - max) + " bytes]" : c;
  return ok("read " + p + " (" + c.length + " B): " + body);
}

function listFiles(ns, a) {
  const prefix = normPath(a.prefix || "/");
  const all = ns.ls("home", prefix === "/" ? "" : prefix);
  if (!all.length) return ok("list_files " + prefix + ": (empty)");
  const head = all.slice(0, 60);
  const more = all.length > 60 ? " ...(" + (all.length - 60) + " more)" : "";
  return ok("list_files " + prefix + " (" + all.length + "): " + head.join(", ") + more);
}

function writeGen(ns, a) {
  const p = normPath(a.path);
  const content = a.content;
  if (!p) return fail("write_generated_script: missing path");
  if (typeof content !== "string") return fail("write_generated_script: content must be a string");
  if (isProtected(p)) return fail("write_generated_script: " + p + " is PROTECTED — use propose_patch");
  if (!isWriteAllowed(p)) return fail("write_generated_script: " + p + " is outside allowed dirs (" + WRITE_ALLOWED_PREFIXES.join(", ") + ")");
  if (content.length > 100_000) return fail("write_generated_script: content > 100 KB, refused");
  ns.write(p, content, "w");
  return ok("wrote " + p + " (" + content.length + " B)");
}

function deleteGen(ns, a) {
  const p = normPath(a.path);
  if (!p) return fail("delete_generated_script: missing path");
  if (isProtected(p)) return fail("delete_generated_script: " + p + " is PROTECTED");
  if (!isWriteAllowed(p)) return fail("delete_generated_script: " + p + " is outside allowed dirs");
  if (!ns.fileExists(p, "home")) return fail("delete_generated_script: not found: " + p);
  return ns.rm(p, "home") ? ok("deleted " + p) : fail("rm refused for " + p);
}

function runScript(ns, a) {
  const p = normPath(a.script);
  const host = a.host || "home";
  const threads = Math.max(1, Math.floor(Number(a.threads) || 1));
  const argv = Array.isArray(a.argv) ? a.argv : [];
  if (!p) return fail("run_script: missing script");
  if (isProtected(p)) return fail("run_script: " + p + " is PROTECTED");
  if (!isWriteAllowed(p)) return fail("run_script: " + p + " must live under " + WRITE_ALLOWED_PREFIXES.join(", "));
  if (!ns.fileExists(p, host)) return fail("run_script: not found on " + host + ": " + p);
  if (host !== "home" && !ns.hasRootAccess(host)) return fail("run_script: no root on " + host);
  const pid = ns.exec(p, host, threads, ...argv);
  return pid > 0 ? ok("ran " + p + " on " + host + " x" + threads + " (pid " + pid + ")") : fail("exec returned 0 — RAM?");
}

function killScript(ns, a) {
  const filename = String(a.script || "").trim();
  const host = a.host || "home";
  if (!filename) return fail("kill_script: missing script");
  let killed = 0;
  for (const proc of ns.ps(host)) {
    if (proc.filename === filename || proc.filename === "/" + filename || proc.filename === filename.replace(/^\//, "")) {
      if (ns.kill(proc.pid)) killed++;
    }
  }
  return killed ? ok("killed " + killed + " " + filename + " on " + host) : fail("no matches for " + filename + " on " + host);
}

function copyScript(ns, a) {
  const p = normPath(a.script);
  const dst = a.dst_host;
  if (!p)   return fail("copy_script: missing script");
  if (!dst) return fail("copy_script: missing dst_host");
  if (isProtected(p)) return fail("copy_script: " + p + " is PROTECTED");
  if (!isWriteAllowed(p)) return fail("copy_script: " + p + " must live under " + WRITE_ALLOWED_PREFIXES.join(", "));
  if (!ns.fileExists(p, "home")) return fail("copy_script: not found on home: " + p);
  if (!ns.hasRootAccess(dst)) return fail("copy_script: no root on " + dst);
  return ns.scp(p, dst, "home") ? ok("copied " + p + " -> " + dst) : fail("scp returned false");
}

function proposePatch(ns, a) {
  const target = normPath(a.target);
  const content = a.content;
  const reason = String(a.reason || "(no reason)");
  if (!target) return fail("propose_patch: missing target");
  if (typeof content !== "string") return fail("propose_patch: content must be a string");
  if (content.length > 200_000) return fail("propose_patch: content > 200 KB, refused");
  if (!isProtected(target)) return fail("propose_patch is for PROTECTED files only — use write_generated_script for " + target);

  const proposal = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    target, reason, bytes: content.length, content
  };
  ns.write(PATCH_PENDING, JSON.stringify(proposal, null, 2), "w");
  const logLine = proposal.iso + " " + target + " (" + proposal.bytes + "B) reason=" +
                  reason.replace(/\s+/g, " ").slice(0, 200) + "\n";
  try { ns.write(PATCH_LOG, logLine, "a"); } catch (_) {}
  ns.toast("AI proposed patch for " + target + " — review with /approve-patch.js", "info", 8000);
  return ok("patch proposed for " + target + " (" + content.length + " B). Run `run /approve-patch.js`.");
}

function ok(r)   { return { success: true,  result: String(r) }; }
function fail(r) { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
