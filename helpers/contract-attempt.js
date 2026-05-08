/**
 * /helpers/contract-attempt.js — submits one or more contract answers
 * CONTRACT_ATTEMPT_VERSION_1
 *
 * One-shot. Reads /Temp/contract-pending.json (a list of attempts),
 * calls codingcontract.attempt for each, writes
 * /Temp/contract-result.json. Pays ~10 GB of the attempt API only
 * while running.
 *
 * Pending shape:
 *   {
 *     _reqId: "...",
 *     attempts: [ { host, name, answer }, ... ]
 *   }
 */

const PENDING = "/Temp/contract-pending.json";
const RESULT  = "/Temp/contract-result.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let req;
  try { req = JSON.parse(ns.read(PENDING)); }
  catch (e) {
    write(ns, { ok: false, error: "bad pending: " + String(e) });
    return;
  }

  const results = [];
  for (const a of (req.attempts || [])) {
    let reward = "";
    let solved = false;
    try {
      reward = ns.codingcontract.attempt(a.answer, a.name, a.host);
      solved = !!reward;
    } catch (e) {
      reward = "threw: " + String(e.message || e);
    }
    results.push({ host: a.host, name: a.name, solved, reward });
  }

  write(ns, {
    _reqId: req._reqId || null,
    ok: true,
    submitted: results.length,
    solved: results.filter((r) => r.solved).length,
    results
  });
}

function write(ns, payload) {
  try { ns.write(RESULT, JSON.stringify({ ts: Date.now(), ...payload }, null, 2), "w"); }
  catch (_) {}
}
