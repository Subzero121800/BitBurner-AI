/**
 * /helpers/download-logs.js — pull /logs/ + /Temp/ to the Mac
 *
 * One-shot. POSTs every file in /logs/ and /Temp/ to the local sink
 * server (scb-watch.js /dl endpoint) running at 127.0.0.1:9999.
 * Files land in .run/downloaded/ on the Mac, preserving directory
 * structure (logs/darknet.txt, Temp/darknet-snap.json, etc.).
 *
 * Run from the terminal:
 *   run /helpers/download-logs.js
 *
 * Optional args:
 *   --host <ip>   sink host (default 127.0.0.1)
 *   --port <n>    sink port (default 9999)
 *   --dir <path>  add extra directory to pull (repeatable)
 */

const DEFAULT_DIRS = ["/logs/", "/Temp/"];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["host", "127.0.0.1"],
    ["port", 9999],
    ["dir",  []],
  ]);

  const host = flags.host;
  const port = Number(flags.port);
  const extra = Array.isArray(flags.dir) ? flags.dir : [flags.dir];
  const dirs  = [...DEFAULT_DIRS, ...extra.filter(Boolean)];

  const endpoint = "http://" + host + ":" + port + "/dl";

  let ok = 0, failed = 0, skipped = 0;

  for (const dir of dirs) {
    let files;
    try { files = ns.ls("home", dir); } catch (_) { continue; }

    for (const file of files) {
      let content = "";
      try { content = ns.read(file); } catch (_) { skipped++; continue; }

      let res;
      try {
        res = await fetch(endpoint, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ path: file, content }),
        });
      } catch (e) {
        ns.tprint("ERR   " + file + " — " + String(e.message || e));
        failed++;
        continue;
      }

      if (res.ok) {
        ns.tprint("OK    " + file);
        ok++;
      } else {
        ns.tprint("FAIL  " + file + " — HTTP " + res.status);
        failed++;
      }
    }
  }

  ns.tprint("─".repeat(50));
  ns.tprint("INFO  download-logs: " + ok + " ok  " + failed + " failed  " + skipped + " skipped");
  ns.tprint("INFO  files are in  .run/downloaded/  on the Mac");
}
