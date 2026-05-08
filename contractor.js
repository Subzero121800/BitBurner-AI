/**
 * contractor.js — coding contract solver (slim orchestrator)
 * CONTRACTOR_VERSION_2_DISPATCH_SPLIT
 *
 * v2 splits the previous monolithic 22 GB script into:
 *   - /helpers/contract-snapshot.js  (transient ~10 GB; finds and reads contracts)
 *   - /helpers/contract-attempt.js   (transient ~10 GB; submits answers)
 *   - contractor.js (this file, ~3 GB resident)
 *
 * Each cycle:
 *   1. Spawn the snapshot helper if /Temp/contracts-snap.json is stale.
 *   2. Read the snap, run pure-JS solvers per contract.
 *   3. Write /Temp/contract-pending.json with batched attempts and
 *      spawn the attempt helper.
 *   4. Read /Temp/contract-result.json (from the previous cycle) for
 *      logging.
 *
 * Solvers are pure functions (no NS calls). Coverage:
 *   - Find Largest Prime Factor
 *   - Subarray with Maximum Sum
 *   - Total Ways to Sum (I + II)
 *   - Spiralize Matrix
 *   - Array Jumping Game (I + II)
 *   - Merge Overlapping Intervals
 *   - Generate IP Addresses
 *   - Algorithmic Stock Trader (I, II, III, IV)
 *   - Minimum Path Sum in a Triangle
 *   - Unique Paths in a Grid (I + II)
 *   - Sanitize Parentheses in Expression
 *   - Find All Valid Math Expressions
 *   - HammingCodes (encode + decode)
 *   - Proper 2-Coloring of a Graph
 *   - Compression I (RLE) + II (LZ decode) + III (LZ encode)
 *   - Encryption I (Caesar) + II (Vigenère)
 *   - Square Root
 */

const POLL_MS         = 60_000;
const SNAP_STALE_MS   = 5 * 60 * 1000;
const SNAP_HELPER     = "/helpers/contract-snapshot.js";
const ATTEMPT_HELPER  = "/helpers/contract-attempt.js";
const SNAP_FILE       = "/Temp/contracts-snap.json";
const PENDING_FILE    = "/Temp/contract-pending.json";
const RESULT_FILE     = "/Temp/contract-result.json";

const LOG_FILE      = "/logs/contractor.txt";
const LOG_PREV      = "/logs/contractor.1.txt";
const LOG_MAX_BYTES = 256_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("INFO  contractor v2 (slim orchestrator) up");
  appendLog(ns, "START contractor v2");

  // First-run bootstrap.
  if (!ns.fileExists(SNAP_FILE, "home")) {
    launchHelper(ns, SNAP_HELPER);
    await ns.sleep(2000);
  }

  while (true) {
    try {
      tick(ns);
      // Refresh the snapshot for next cycle if stale.
      const snap = readJson(ns, SNAP_FILE);
      if (!snap || (Date.now() - (snap.ts || 0)) > SNAP_STALE_MS) {
        launchHelper(ns, SNAP_HELPER);
      }
    } catch (e) {
      ns.print("ERROR  cycle: " + String(e.message || e));
      appendLog(ns, "ERROR " + String(e.message || e));
    }
    await ns.sleep(POLL_MS);
  }
}

function tick(ns) {
  // Log result from any previous attempt batch.
  const lastResult = readJson(ns, RESULT_FILE);
  if (lastResult && Array.isArray(lastResult.results)) {
    for (const r of lastResult.results) {
      const tag = r.solved ? "SOLVED " : "FAILED ";
      appendLog(ns, tag + r.name + " on " + r.host + " => " + (r.reward || "(no reward)"));
    }
  }

  const snap = readJson(ns, SNAP_FILE);
  if (!snap || !Array.isArray(snap.contracts)) {
    ns.print("INFO  no contract snapshot yet");
    return;
  }
  if (!snap.contracts.length) {
    ns.print("INFO  no contracts available");
    return;
  }

  const attempts = [];
  let unsolvable = 0;
  for (const c of snap.contracts) {
    if (!c.type || c.data == null) continue;
    let answer;
    try { answer = solve(c.type, c.data); }
    catch (e) {
      appendLog(ns, "SOLVER threw on " + c.type + " (" + c.name + "): " + String(e.message || e));
      continue;
    }
    if (answer == null) { unsolvable++; continue; }
    attempts.push({ host: c.host, name: c.name, answer });
  }

  if (!attempts.length) {
    ns.print("INFO  found=" + snap.contracts.length + " solvable=0 unsolvable=" + unsolvable);
    return;
  }

  ns.write(PENDING_FILE, JSON.stringify({
    _reqId: String(Date.now()),
    attempts
  }), "w");
  launchHelper(ns, ATTEMPT_HELPER);
  ns.print("INFO  found=" + snap.contracts.length + " queued=" + attempts.length + " unsolvable=" + unsolvable);
}

// ───────────────────────────────────────────────────────────────────
// Solver dispatch
// ───────────────────────────────────────────────────────────────────
function solve(type, data) {
  switch (type) {
    case "Find Largest Prime Factor":          return solveLargestPrimeFactor(data);
    case "Subarray with Maximum Sum":          return solveMaxSubarraySum(data);
    case "Total Ways to Sum":                  return solveTotalWaysToSum(data);
    case "Total Ways to Sum II":               return solveTotalWaysToSumII(data);
    case "Spiralize Matrix":                   return solveSpiralize(data);
    case "Array Jumping Game":                 return solveArrayJumpI(data);
    case "Array Jumping Game II":              return solveArrayJumpII(data);
    case "Merge Overlapping Intervals":        return solveMergeIntervals(data);
    case "Generate IP Addresses":              return solveGenerateIPs(data);
    case "Algorithmic Stock Trader I":         return solveStockI(data);
    case "Algorithmic Stock Trader II":        return solveStockII(data);
    case "Algorithmic Stock Trader III":       return solveStockK(data, 2);
    case "Algorithmic Stock Trader IV":        return solveStockK(data[1], data[0]);
    case "Minimum Path Sum in a Triangle":     return solveMinTriangle(data);
    case "Unique Paths in a Grid I":           return solveUniquePathsI(data);
    case "Unique Paths in a Grid II":          return solveUniquePathsII(data);
    case "Sanitize Parentheses in Expression": return solveSanitizeParens(data);
    case "Find All Valid Math Expressions":    return solveMathExpressions(data);
    case "HammingCodes: Integer to Encoded Binary": return solveHammingEncode(data);
    case "HammingCodes: Encoded Binary to Integer": return solveHammingDecode(data);
    case "Proper 2-Coloring of a Graph":       return solveTwoColor(data);
    case "Compression I: RLE Compression":     return solveRLE(data);
    case "Compression II: LZ Decompression":   return solveLZDecode(data);
    case "Compression III: LZ Compression":    return solveLZEncode(data);
    case "Encryption I: Caesar Cipher":        return solveCaesar(data);
    case "Encryption II: Vigenère Cipher":     return solveVigenere(data);
    case "Square Root":                        return solveSquareRoot(data);
    default: return null;
  }
}

// ─── solvers ───────────────────────────────────────────────────────

function solveLargestPrimeFactor(n) {
  let d = 2;
  while (n > 1) {
    while (n % d === 0) { if (d * d > n && n > 1) { d = n; break; } n = n / d; }
    d++;
  }
  return d;
}

function solveMaxSubarraySum(arr) {
  let best = arr[0], cur = arr[0];
  for (let i = 1; i < arr.length; i++) { cur = Math.max(arr[i], cur + arr[i]); best = Math.max(best, cur); }
  return best;
}

function solveTotalWaysToSum(n) {
  const dp = new Array(n + 1).fill(0); dp[0] = 1;
  for (let i = 1; i < n; i++) for (let j = i; j <= n; j++) dp[j] += dp[j - i];
  return dp[n];
}

function solveTotalWaysToSumII([n, parts]) {
  const dp = new Array(n + 1).fill(0); dp[0] = 1;
  for (const p of parts) for (let j = p; j <= n; j++) dp[j] += dp[j - p];
  return dp[n];
}

function solveSpiralize(m) {
  const out = [];
  if (!m.length) return out;
  let top = 0, bot = m.length - 1, left = 0, right = m[0].length - 1;
  while (top <= bot && left <= right) {
    for (let c = left; c <= right; c++) out.push(m[top][c]); top++;
    for (let r = top;  r <= bot;   r++) out.push(m[r][right]); right--;
    if (top <= bot) for (let c = right; c >= left; c--) out.push(m[bot][c]); bot--;
    if (left <= right) for (let r = bot; r >= top; r--) out.push(m[r][left]); left++;
  }
  return out;
}

function solveArrayJumpI(arr) {
  let reach = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i > reach) return 0;
    reach = Math.max(reach, i + arr[i]);
  }
  return 1;
}

function solveArrayJumpII(arr) {
  let jumps = 0, end = 0, reach = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    reach = Math.max(reach, i + arr[i]);
    if (i === end) { if (i === reach) return 0; jumps++; end = reach; }
  }
  return jumps;
}

function solveMergeIntervals(intervals) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    if (out.length && iv[0] <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
    } else out.push(iv.slice());
  }
  return out;
}

function solveGenerateIPs(s) {
  const out = [];
  for (let a = 1; a < 4; a++) for (let b = 1; b < 4; b++)
    for (let c = 1; c < 4; c++) for (let d = 1; d < 4; d++) {
      if (a + b + c + d !== s.length) continue;
      const A = s.slice(0, a), B = s.slice(a, a + b), C = s.slice(a + b, a + b + c), D = s.slice(a + b + c);
      if (validIPPart(A) && validIPPart(B) && validIPPart(C) && validIPPart(D)) out.push(A + "." + B + "." + C + "." + D);
    }
  return out;
}
function validIPPart(p) {
  if (p.length > 1 && p[0] === "0") return false;
  const n = Number(p); return n >= 0 && n <= 255;
}

function solveStockI(prices) {
  let min = Infinity, best = 0;
  for (const p of prices) { if (p < min) min = p; else best = Math.max(best, p - min); }
  return best;
}
function solveStockII(prices) {
  let total = 0;
  for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) total += prices[i] - prices[i - 1];
  return total;
}
function solveStockK(prices, k) {
  if (!prices || !prices.length || !k) return 0;
  if (k >= prices.length / 2) return solveStockII(prices);
  const buy = new Array(k + 1).fill(-Infinity);
  const sell = new Array(k + 1).fill(0);
  for (const p of prices) for (let i = 1; i <= k; i++) {
    buy[i] = Math.max(buy[i], sell[i - 1] - p);
    sell[i] = Math.max(sell[i], buy[i] + p);
  }
  return sell[k];
}

function solveMinTriangle(t) {
  const dp = t[t.length - 1].slice();
  for (let r = t.length - 2; r >= 0; r--)
    for (let c = 0; c < t[r].length; c++) dp[c] = t[r][c] + Math.min(dp[c], dp[c + 1]);
  return dp[0];
}
function solveUniquePathsI([rows, cols]) {
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++) dp[r][0] = 1;
  for (let c = 0; c < cols; c++) dp[0][c] = 1;
  for (let r = 1; r < rows; r++) for (let c = 1; c < cols; c++) dp[r][c] = dp[r - 1][c] + dp[r][c - 1];
  return dp[rows - 1][cols - 1];
}
function solveUniquePathsII(grid) {
  const R = grid.length, C = grid[0].length;
  const dp = Array.from({ length: R }, () => new Array(C).fill(0));
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (grid[r][c]) { dp[r][c] = 0; continue; }
    if (r === 0 && c === 0) { dp[r][c] = 1; continue; }
    dp[r][c] = (r ? dp[r - 1][c] : 0) + (c ? dp[r][c - 1] : 0);
  }
  return dp[R - 1][C - 1];
}

function solveSanitizeParens(s) {
  const out = new Set();
  let toRemoveOpen = 0, toRemoveClose = 0;
  for (const ch of s) {
    if (ch === "(") toRemoveOpen++;
    else if (ch === ")") { if (toRemoveOpen > 0) toRemoveOpen--; else toRemoveClose++; }
  }
  function bt(idx, cur, openLeft, closeLeft, balance) {
    if (idx === s.length) {
      if (openLeft === 0 && closeLeft === 0 && balance === 0) out.add(cur);
      return;
    }
    const ch = s[idx];
    if (ch === "(" && openLeft > 0) bt(idx + 1, cur, openLeft - 1, closeLeft, balance);
    if (ch === ")" && closeLeft > 0) bt(idx + 1, cur, openLeft, closeLeft - 1, balance);
    bt(idx + 1, cur + ch, openLeft, closeLeft,
       ch === "(" ? balance + 1 : ch === ")" ? balance - 1 : balance);
    if (balance < 0) return;
  }
  bt(0, "", toRemoveOpen, toRemoveClose, 0);
  return [...out];
}

function solveMathExpressions([digits, target]) {
  const out = [];
  function bt(pos, expr, value, last) {
    if (pos === digits.length) { if (value === target) out.push(expr); return; }
    for (let i = pos; i < digits.length; i++) {
      const sub = digits.substring(pos, i + 1);
      const num = Number(sub);
      if (sub.length > 1 && sub[0] === "0") break;
      if (pos === 0) bt(i + 1, sub, num, num);
      else {
        bt(i + 1, expr + "+" + sub, value + num, num);
        bt(i + 1, expr + "-" + sub, value - num, -num);
        bt(i + 1, expr + "*" + sub, value - last + last * num, last * num);
      }
    }
  }
  bt(0, "", 0, 0);
  return out;
}

function solveHammingEncode(n) {
  const bits = n.toString(2).split("").map(Number);
  let p = 0;
  while ((1 << p) < bits.length + p + 1) p++;
  const len = bits.length + p + 1;
  const code = new Array(len).fill(0);
  // Place data bits in non-power-of-2 positions
  let bi = 0;
  for (let i = 1; i < len; i++) {
    if ((i & (i - 1)) === 0) continue; // power of 2
    code[i] = bits[bi++];
  }
  // Compute parity for each power-of-2 position
  for (let pi = 0; pi < p; pi++) {
    const mask = 1 << pi;
    let sum = 0;
    for (let i = 1; i < len; i++) if ((i & mask) && i !== mask) sum ^= code[i];
    code[mask] = sum;
  }
  // Overall parity at index 0
  let overall = 0;
  for (let i = 1; i < len; i++) overall ^= code[i];
  code[0] = overall;
  return code.join("");
}
function solveHammingDecode(s) {
  const bits = s.split("").map(Number);
  const len = bits.length;
  let err = 0;
  for (let pi = 0; (1 << pi) < len; pi++) {
    const mask = 1 << pi;
    let sum = 0;
    for (let i = 1; i < len; i++) if (i & mask) sum ^= bits[i];
    if (sum) err |= mask;
  }
  if (err && err < len) bits[err] ^= 1;
  let result = "";
  for (let i = 1; i < len; i++) {
    if ((i & (i - 1)) === 0) continue;
    result += bits[i];
  }
  return parseInt(result, 2);
}

function solveTwoColor([numNodes, edges]) {
  const adj = Array.from({ length: numNodes }, () => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const color = new Array(numNodes).fill(-1);
  for (let i = 0; i < numNodes; i++) {
    if (color[i] !== -1) continue;
    color[i] = 0;
    const q = [i];
    while (q.length) {
      const u = q.shift();
      for (const v of adj[u]) {
        if (color[v] === -1) { color[v] = 1 - color[u]; q.push(v); }
        else if (color[v] === color[u]) return [];
      }
    }
  }
  return color;
}

function solveRLE(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    let run = 1;
    while (i + run < s.length && s[i + run] === s[i] && run < 9) run++;
    out += run + s[i];
    i += run;
  }
  return out;
}
function solveLZDecode(s) {
  let out = "";
  let i = 0;
  let chunkType = 1;
  while (i < s.length) {
    const len = parseInt(s[i], 10);
    i++;
    if (len > 0) {
      if (chunkType === 1) {
        out += s.substr(i, len);
        i += len;
      } else {
        const offset = parseInt(s[i], 10);
        i++;
        for (let k = 0; k < len; k++) out += out[out.length - offset];
      }
    }
    chunkType = chunkType === 1 ? 2 : 1;
  }
  return out;
}
function solveLZEncode(s) {
  // Brute-force LZ encoder; correct but not optimally fast.
  // States are { type: 1|2, encoded: "" }. We DP across positions.
  if (!s.length) return "";
  let cur = [["", ""]]; // [type1Best, type2Best] keyed by position 0
  cur[0][0] = "0"; // start with type 1, no chars consumed
  for (let i = 1; i <= s.length; i++) cur[i] = ["", ""];
  for (let i = 0; i < s.length; i++) {
    if (cur[i][0] !== "") {
      // type 1 chunk: 1..9 literal chars
      for (let len = 1; len <= 9 && i + len <= s.length; len++) {
        const chunk = len + s.substr(i, len);
        const next = cur[i][0] + chunk;
        if (cur[i + len][1] === "" || next.length + 1 <= cur[i + len][1].length) cur[i + len][1] = next;
      }
      // zero-length type 1 -> switch
      if (cur[i][1] === "" || cur[i][0].length + 1 < cur[i][1].length) {
        // We can also skip type 2 by emitting "0" then type 1 — handled below via 0-len type 2
      }
    }
    if (cur[i][1] !== "") {
      // type 2 chunk: 1..9 length, with offset 1..9
      for (let off = 1; off <= 9 && off <= i; off++) {
        let len = 0;
        while (len < 9 && i + len < s.length && s[i + len - off] === s[i + len]) len++;
        for (let l = 1; l <= len; l++) {
          const chunk = "" + l + off;
          const next = cur[i][1] + chunk;
          if (cur[i + l][0] === "" || next.length + 1 <= cur[i + l][0].length) cur[i + l][0] = next;
        }
      }
      // zero-length type 2 -> switch back to type 1
      const skip = cur[i][1] + "0";
      if (cur[i][0] === "" || skip.length < cur[i][0].length) cur[i][0] = skip;
    }
  }
  const a = cur[s.length][0], b = cur[s.length][1];
  if (a === "" && b === "") return "";
  if (a === "") return b;
  if (b === "") return a;
  return a.length <= b.length ? a : b;
}

function solveCaesar([s, shift]) {
  let out = "";
  for (const ch of s) {
    if (ch === " ") { out += " "; continue; }
    const c = ch.charCodeAt(0) - 65;
    out += String.fromCharCode(((c - shift + 26) % 26) + 65);
  }
  return out;
}
function solveVigenere([text, key]) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const t = text.charCodeAt(i) - 65;
    const k = key.charCodeAt(i % key.length) - 65;
    out += String.fromCharCode(((t + k) % 26) + 65);
  }
  return out;
}

function solveSquareRoot(n) {
  // n may be a BigInt or string for very large values
  const big = typeof n === "bigint" ? n : BigInt(n);
  if (big < 0n) return "0";
  if (big < 2n) return big.toString();
  let lo = 0n;
  let hi = big;
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid * mid <= big) lo = mid; else hi = mid - 1n;
  }
  // Round to nearest integer
  const lower = lo;
  const upper = lo + 1n;
  return ((upper * upper - big) < (big - lower * lower) ? upper : lower).toString();
}

// ─── plumbing ──────────────────────────────────────────────────────
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
