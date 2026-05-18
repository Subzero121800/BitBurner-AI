/**
 * /helpers/darknet-crawler.js — self-replicating darknet node crawler
 * DARKNET_CRAWLER_VERSION_3
 *
 * v2 changes:
 *   - Fix ZeroLogon password: "0" not "" (empty string)
 *   - Full hint-based password solver matching darknet-manager logic
 *   - Pass own hostname as arg[0] when exec-ing onto child servers
 *   - Better auth logging including password hint
 *
 * Deploy once onto darkweb (from darknet-manager.js). It then:
 *   1. Calls probe() from its current host to see adjacent servers
 *   2. Authenticates each using the hint-based solver
 *   3. SCPs itself + execs on each newly authenticated server
 *   4. Writes /Temp/darknet-disc-{myHost}.json and SCPs back to home
 *
 * ns.args[0] = parent hostname (for tracing the spread path)
 */

const CRAWLER   = "/helpers/darknet-crawler.js";
const DISC_DIR  = "/Temp/";
const LOOP_MS   = 30_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const myHost = ns.getHostname();
  const parent = ns.args[0] ? String(ns.args[0]) : "unknown";
  ns.print("INFO  darknet-crawler v2 up on " + myHost + " (parent=" + parent + ")");

  while (true) {
    try { await crawl(ns, myHost); }
    catch (e) { ns.print("WARN  crawl: " + String(e.message || e)); }
    await ns.sleep(LOOP_MS);
  }
}

async function crawl(ns, myHost) {
  let neighbors = [];
  try { neighbors = ns.dnet.probe() || []; } catch (_) { return; }

  const disc = { ts: Date.now(), host: myHost, neighbors, discoveries: [] };

  for (const host of neighbors) {
    let details = {};
    try { details = ns.dnet.getServerAuthDetails(host) || {}; } catch (_) {}

    if (details.isOnline === false || details.isConnectedToCurrentServer === false) continue;

    const entry = { host, modelId: details.modelId || null, authenticated: false };

    if (details.hasSession) {
      entry.authenticated = true;
      disc.discoveries.push(entry);
      await spread(ns, host, myHost);
      continue;
    }

    const passwords = solvePasswords(details);
    if (!passwords.length) {
      ns.print("INFO  crawler: no pw candidates for " + host +
               " model=" + (details.modelId || "?") +
               " hint=" + String(details.passwordHint || "(none)").slice(0, 60));
      disc.discoveries.push(entry);
      continue;
    }

    let ok = false;
    let successPw = null;
    for (const pw of passwords) {
      if (ok) break;
      let r = null;
      try { r = await ns.dnet.authenticate(host, pw, 0); } catch (_) { break; }
      if (r?.success) { ok = true; successPw = pw; }
    }

    if (ok) {
      entry.authenticated = true;
      ns.print("SUCCESS  crawler: authed " + host +
                " (model=" + (details.modelId || "?") +
                ", pw=" + JSON.stringify(successPw) + ") on " + myHost);
      await spread(ns, host, myHost);
    } else {
      // Peek heartbleed to surface password hints for review.
      try {
        const hb = await ns.dnet.heartbleed(host, { threads: 1, peek: true });
        if (hb?.logs) ns.print("INFO  hb peek " + host + ": " + String(hb.logs).slice(0, 200));
      } catch (_) {}
    }

    disc.discoveries.push(entry);
  }

  // Write report and ship back to home for snapshot to merge.
  const reportFile = DISC_DIR + "darknet-disc-" + myHost + ".json";
  try { ns.write(reportFile, JSON.stringify(disc), "w"); } catch (_) {}
  try { ns.scp(reportFile, "home"); } catch (_) {}
}

async function spread(ns, host, parentHost) {
  try { ns.scp(CRAWLER, host, "home"); } catch (_) {}
  let pid = 0;
  try { pid = ns.exec(CRAWLER, host, { preventDuplicates: true, threads: 1 }, parentHost); } catch (_) {}
  if (!pid) {
    try { pid = ns.exec(CRAWLER, host, 1, parentHost); } catch (_) {}
  }
  if (pid > 0) ns.print("INFO  crawler spread → " + host + " (pid=" + pid + ")");
  else         ns.print("WARN  crawler exec failed on " + host);
}

// ─── password solver — must stay in sync with darknet-manager.js ─────
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

function solvePasswords(authDetails) {
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

  if (!hint) return [];

  if (words.some(w => ["default", "factory", "never"].includes(w))) {
    return ["0000", "12345", "admin", "password"];
  }
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
  return [];
}
