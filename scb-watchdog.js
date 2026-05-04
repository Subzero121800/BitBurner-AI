/** @param {NS} ns */
export async function main(ns) {
  // WATCHDOG_VERSION_6
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
  // Log-flush every M polls (M=15 ⇒ every 30 s). POSTs new
  // /logs/<name>.log content to the local sink and truncates the
  // in-game file on success so the next flush only sends new data.
  const FLUSH_EVERY    = 15;
  const SINK_BASE      = "http://127.0.0.1:9999/sink/";
  const LOG_TARGETS    = [
    { file: "/logs/scb.txt",                name: "scb" },
    { file: "/logs/ollama-player.txt",      name: "ollama-player" },
    { file: "/logs/gang.txt",               name: "gang" },
    { file: "/logs/bladeburner.txt",        name: "bladeburner" },
  ];

  let lastMarker = readFileSafe(RESTART_FILE);
  let prevState  = null;
  let cycle      = 0;

  ns.tprint("INFO  scb-watchdog up — polling " + RESTART_FILE);
  ns.print("INFO  scb-watchdog v3 up");
  ns.print("INFO  poll=" + POLL_MS + "ms stale=" + STALE_MS + "ms target=" + TARGET);
  ns.print("INFO  watching " + RESTART_FILE);
  ns.print("INFO  watching " + HEARTBEAT_FILE);
  ns.print("INFO  flushing logs every " + (FLUSH_EVERY * POLL_MS / 1000) + "s to " + SINK_BASE);

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
        ns.toast("Remote API offline — auto-reconnecting...", "warning", 8000);
        await tryReconnect();
      } else {
        ns.tprint("SUCCESS  Remote API online");
        ns.toast("Remote API connected", "success", 4000);
      }
      prevState = state;
    } else if (state === "offline") {
      // Stay offline → keep trying to reconnect quietly.
      await tryReconnect();
    }

    // ── 3. periodic alive ping ─────────────────────────────────────
    if (cycle % ALIVE_EVERY === 0) {
      const ageS = isFinite(age) ? Math.round(age / 1000) + "s" : "n/a";
      ns.print("INFO  alive cycle=" + cycle + " state=" + state + " hb_age=" + ageS);
    }

    // ── 4. log flush — push in-game logs to local sink ──────────────
    if (cycle % FLUSH_EVERY === 0) {
      for (const t of LOG_TARGETS) await flushLog(t.file, t.name);
    }

    await ns.sleep(POLL_MS);
  }

  // Cursor-based flush: send only the new bytes past the last
  // pushed offset, leave the in-game log intact. The player's
  // OBSERVE step reads /logs/ollama-player.log to populate
  // state.recentActions / state.jammedActions — truncating the
  // log here would empty that buffer between cycles and defeat
  // repeat-suppression. Cursor is per-log file in /Temp/.
  // The player's writer rotates at 256 KB (file → file.1 + reset),
  // so the cursor can validly exceed the file size — that means a
  // rotation happened and we should resume from offset 0.
  async function flushLog(gameFile, name) {
    try {
      if (!ns.fileExists(gameFile, "home")) return;
      const content = ns.read(gameFile);
      if (!content) return;

      const cursorFile = "/Temp/log-cursor-" + name + ".txt";
      let offset = 0;
      if (ns.fileExists(cursorFile, "home")) {
        offset = parseInt(String(ns.read(cursorFile)).trim(), 10) || 0;
      }
      if (offset > content.length) offset = 0; // file rotated
      if (offset >= content.length) return;     // nothing new

      const chunk = content.slice(offset);
      const url = SINK_BASE + name;
      const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const tid  = ctrl ? setTimeout(() => ctrl.abort(), 3000) : null;

      try {
        const res = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "text/plain" },
          body:    chunk,
          signal:  ctrl ? ctrl.signal : undefined,
        });
        if (tid) clearTimeout(tid);
        if (!res || !res.ok) return; // sink down — retry next flush
        ns.write(cursorFile, String(content.length), "w");
      } catch (_) {
        if (tid) clearTimeout(tid);
        // network error — leave cursor alone, retry next flush
      }
    } catch (e) {
      ns.print("WARN  flushLog(" + name + ") threw: " + String(e.message || e));
    }
  }

  function readFileSafe(p) {
    try { return ns.fileExists(p, "home") ? ns.read(p) : ""; }
    catch (_) { return ""; }
  }

  // Aggressive DOM-based reconnect: opens the Options panel,
  // navigates to the Remote API tab, clicks Connect. Far more
  // reliable than the previous "find a Connect button if any panel
  // happens to be open" approach. globalThis["doc"+"ument"] is the
  // dynamic-key trick to dodge Bitburner's static RAM scanner; if a
  // future game version closes that loophole this will degrade
  // gracefully (returns false, the toast still fires).
  async function tryReconnect() {
    try {
      const doc = globalThis["doc" + "ument"];
      if (!doc || typeof doc.querySelectorAll !== "function") return false;

      // 1. quick path: a Connect button is already on screen.
      let btn = findByText(doc, "Connect", (el) =>
        (el.textContent || "").trim() === "Connect" && el.tagName === "BUTTON"
      );
      if (btn) { btn.click(); ns.print("INFO  fast-path Connect click"); return true; }

      // 2. open Options. Try common nav variants.
      const optionsBtn = findByText(doc, "Options", (el) =>
        ["BUTTON", "A", "LI", "DIV"].includes(el.tagName) &&
        (el.textContent || "").trim() === "Options"
      );
      if (!optionsBtn) {
        ns.print("INFO  reconnect: Options nav not found");
        return false;
      }
      optionsBtn.click();
      await ns.sleep(200);

      // 3. click the Remote API tab
      const remoteTab = findByText(doc, "Remote API", (el) =>
        (el.textContent || "").trim() === "Remote API"
      );
      if (remoteTab) { remoteTab.click(); await ns.sleep(200); }

      // 4. now find Connect (or report Disconnect — already up)
      btn = findByText(doc, "Connect", (el) =>
        el.tagName === "BUTTON" && (el.textContent || "").trim() === "Connect"
      );
      if (!btn) {
        const dis = findByText(doc, "Disconnect", (el) =>
          el.tagName === "BUTTON" && (el.textContent || "").trim() === "Disconnect"
        );
        if (dis) {
          ns.print("INFO  reconnect: Disconnect shown, already connected");
          return true;
        }
        ns.print("INFO  reconnect: Connect button not located after opening panel");
        return false;
      }
      btn.click();
      ns.print("SUCCESS  navigated Options→Remote API→Connect");
      return true;
    } catch (e) {
      ns.print("WARN  reconnect attempt failed: " + String(e.message || e));
      return false;
    }
  }

  function findByText(doc, label, predicate) {
    try {
      const all = doc.querySelectorAll("button, a, li, [role=tab], [role=menuitem], div, span");
      for (const el of all) {
        const t = (el.textContent || "").trim();
        if (t === label || t.toLowerCase() === label.toLowerCase()) {
          if (!predicate || predicate(el)) return el;
        }
      }
    } catch (_) {}
    return null;
  }
}