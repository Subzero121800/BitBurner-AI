/** @param {NS} ns */
export async function main(ns) {
  // WATCHDOG_VERSION_2
  ns.disableLog("ALL");
  try { ns.ui?.openTail?.(); } catch (_) {}

  const RESTART_FILE   = "/Temp/scb-restart.txt";
  const HEARTBEAT_FILE = "/Temp/scb-heartbeat.txt";
  const TARGET         = "scb.js";
  const POLL_MS        = 2000;
  const STALE_MS       = 15000;
  // Emit an "alive" line every N polls so the tail isn't blank when
  // nothing has changed — confirms the watchdog is actually running.
  const ALIVE_EVERY    = 30;

  let lastMarker = readFileSafe(RESTART_FILE);
  let prevState  = null;
  let cycle      = 0;

  ns.tprint("INFO  scb-watchdog up — polling " + RESTART_FILE);
  ns.print("INFO  scb-watchdog v2 up");
  ns.print("INFO  poll=" + POLL_MS + "ms stale=" + STALE_MS + "ms target=" + TARGET);
  ns.print("INFO  watching " + RESTART_FILE);
  ns.print("INFO  watching " + HEARTBEAT_FILE);

  while (true) {
    cycle++;
    // ── 1. restart marker → hot-reload scb.js ──────────────────────
    const cur = readFileSafe(RESTART_FILE);
    if (cur && cur !== lastMarker) {
      lastMarker = cur;
      const wasRunning = ns.ps("home").some(p => p.filename === TARGET);
      if (wasRunning) {
        ns.print("INFO  marker changed; bouncing " + TARGET);
        for (const p of ns.ps("home")) if (p.filename === TARGET) ns.kill(p.pid);
        await ns.sleep(500);
        const pid = ns.exec(TARGET, "home", 1);
        if (pid > 0) ns.tprint("SUCCESS  hot-reloaded " + TARGET + " (pid " + pid + ")");
        else         ns.tprint("ERROR    hot-reload exec failed (RAM?)");
      } else {
        ns.print("INFO  marker changed but " + TARGET + " not running — skipping");
      }
    }

    // ── 2. heartbeat → connection state ────────────────────────────
    const beatStr = readFileSafe(HEARTBEAT_FILE).trim();
    const beat    = beatStr ? Number(beatStr) : 0;
    const age     = beat ? Date.now() - beat : Infinity;
    const state   = age < STALE_MS ? "online" : "offline";
    if (state !== prevState) {
      if (state === "offline") {
        const ageS = isFinite(age) ? Math.round(age / 1000) + "s" : "never";
        ns.tprint("WARN  Remote API offline (heartbeat " + ageS + ")");
        ns.toast("Remote API offline — click Connect", "warning", 8000);
        tryReconnect();
      } else {
        ns.tprint("SUCCESS  Remote API online");
        ns.toast("Remote API connected", "success", 4000);
      }
      prevState = state;
    } else if (state === "offline") {
      // Stay offline → keep trying to reconnect quietly.
      tryReconnect();
    }

    // ── 3. periodic alive ping ─────────────────────────────────────
    if (cycle % ALIVE_EVERY === 0) {
      const ageS = isFinite(age) ? Math.round(age / 1000) + "s" : "n/a";
      ns.print("INFO  alive cycle=" + cycle + " state=" + state + " hb_age=" + ageS);
    }

    await ns.sleep(POLL_MS);
  }

  function readFileSafe(p) {
    try { return ns.fileExists(p, "home") ? ns.read(p) : ""; }
    catch (_) { return ""; }
  }

  function tryReconnect() {
    try {
      const doc = globalThis["doc" + "ument"];
      if (!doc || typeof doc.querySelectorAll !== "function") return false;
      const btns = Array.from(doc.querySelectorAll("button"));
      const btn  = btns.find(b => (b.textContent || "").trim() === "Connect");
      if (btn) { btn.click(); ns.print("INFO  clicked Remote API Connect button"); return true; }
    } catch (e) {
      ns.print("WARN  reconnect attempt failed: " + String(e.message || e));
    }
    return false;
  }
}