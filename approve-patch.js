/**
 * approve-patch.js — human-in-the-loop reviewer for AI-proposed patches
 *
 * The AI writes proposed changes to PROTECTED files into
 *   /ai/patches/pending-patch.json
 * via the `propose_patch` action. This script reads that proposal,
 * shows it to you, and only applies it if you explicitly pass --approve.
 *
 * Usage (in-game terminal):
 *   run /approve-patch.js               — show the pending patch and exit
 *   run /approve-patch.js --approve     — actually apply it
 *   run /approve-patch.js --discard     — delete the pending patch without applying
 *   run /approve-patch.js --list        — show the proposal log (last 20)
 *
 * Applied patches are archived to /ai/patches/applied-<ts>.json so you
 * can roll back by hand if needed. The pending file is removed once a
 * patch is applied or discarded.
 */

const PENDING = "/ai/patches/pending-patch.json";
const LOG     = "/ai/patches/proposals.log";
const APPLY_LOG = "/ai/patches/applied.log";

const PROTECTED = new Set([
  "/scb.js",            "scb.js",
  "/ollama-player.js",  "ollama-player.js",
  "/ollama-actions.js", "ollama-actions.js",
  "/scb-watchdog.js",   "scb-watchdog.js",
  "/server-upgrader.js","server-upgrader.js",
  "/contractor.js",     "contractor.js",
  "/hack.js",  "hack.js",
  "/grow.js",  "grow.js",
  "/weaken.js","weaken.js",
  "/helpers.js","helpers.js",
  "/autopilot.js","autopilot.js",
]);

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  const args = ns.args.map(String);
  const approve = args.includes("--approve");
  const discard = args.includes("--discard");
  const list    = args.includes("--list");

  if (list) return showLog(ns);

  if (!ns.fileExists(PENDING, "home")) {
    ns.tprint("INFO  no pending patch at " + PENDING);
    return;
  }

  let proposal;
  try {
    proposal = JSON.parse(ns.read(PENDING));
  } catch (e) {
    ns.tprint("ERROR  could not parse " + PENDING + ": " + String(e));
    return;
  }

  const target = String(proposal.target || "");
  const content = String(proposal.content || "");

  if (!target) {
    ns.tprint("ERROR  proposal missing .target");
    return;
  }

  ns.tprint("");
  ns.tprint("───────────────────────────────────────────────────────────");
  ns.tprint("PENDING PATCH");
  ns.tprint("  target:  " + target);
  ns.tprint("  bytes:   " + content.length);
  ns.tprint("  when:    " + (proposal.iso || new Date(proposal.ts || 0).toISOString()));
  ns.tprint("  reason:  " + String(proposal.reason || "(none)"));
  ns.tprint("───────────────────────────────────────────────────────────");

  if (discard) {
    ns.rm(PENDING, "home");
    ns.tprint("INFO  proposal discarded — " + PENDING + " removed");
    appendLog(ns, "DISCARDED " + target + " (" + content.length + " B)");
    return;
  }

  if (!approve) {
    // Preview the first chunk of the patch + last chunk so the user
    // can sanity-check intent without flooding the terminal.
    const head = content.slice(0, 1500);
    const tail = content.length > 3000 ? "\n...\n" + content.slice(-1000) : "";
    ns.tprint("");
    ns.tprint("PROPOSED CONTENT (preview):");
    ns.tprint(head + tail);
    ns.tprint("───────────────────────────────────────────────────────────");
    ns.tprint("To apply:    run /approve-patch.js --approve");
    ns.tprint("To discard:  run /approve-patch.js --discard");
    return;
  }

  // ── apply ────────────────────────────────────────────────────────
  if (!PROTECTED.has(target)) {
    ns.tprint("ERROR  refusing to apply: target " + target + " is not in the PROTECTED list, this script is the wrong tool");
    return;
  }

  // Snapshot the current contents before we overwrite, so the user
  // can roll back manually.
  const archive = "/ai/patches/applied-" + Date.now() + ".json";
  try {
    const prev = ns.fileExists(target, "home") ? ns.read(target) : "";
    ns.write(archive, JSON.stringify({
      ts: Date.now(),
      iso: new Date().toISOString(),
      target,
      reason: String(proposal.reason || ""),
      previous: prev,
      applied: content,
    }, null, 2), "w");
  } catch (e) {
    ns.tprint("WARN  could not write archive " + archive + ": " + String(e));
    ns.tprint("WARN  aborting apply — you'd have no rollback. Inspect manually.");
    return;
  }

  try {
    ns.write(target, content, "w");
  } catch (e) {
    ns.tprint("ERROR  write failed: " + String(e));
    return;
  }

  ns.rm(PENDING, "home");
  appendLog(ns, "APPLIED " + target + " (" + content.length + " B) → archive " + archive);
  ns.tprint("SUCCESS  patched " + target + " — archive saved at " + archive);
  ns.tprint("INFO  pending file removed");
  ns.tprint("INFO  hot-reload will pick up the change automatically if " + target + " is watched");
}

/** @param {NS} ns */
function showLog(ns) {
  if (!ns.fileExists(LOG, "home") && !ns.fileExists(APPLY_LOG, "home")) {
    ns.tprint("INFO  no proposal history yet");
    return;
  }
  if (ns.fileExists(LOG, "home")) {
    ns.tprint("─── proposals (last 20) ───");
    const lines = ns.read(LOG).trim().split(/\n/).slice(-20);
    for (const l of lines) ns.tprint("  " + l);
  }
  if (ns.fileExists(APPLY_LOG, "home")) {
    ns.tprint("─── applied (last 20) ───");
    const lines = ns.read(APPLY_LOG).trim().split(/\n/).slice(-20);
    for (const l of lines) ns.tprint("  " + l);
  }
}

/** @param {NS} ns */
function appendLog(ns, line) {
  try { ns.write(APPLY_LOG, new Date().toISOString() + " " + line + "\n", "a"); }
  catch (_) {}
}
