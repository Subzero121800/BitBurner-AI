/**
 * /helpers/ai-fetch.js — one-shot HTTP POST helper for the AI player
 * AI_FETCH_VERSION_1
 *
 * Bitburner charges a hefty static RAM cost for the global fetch /
 * AbortController surface (~25 GB on the importing script). Holding
 * that in the resident ollama-player.js was the bulk of its remaining
 * footprint after v9. This helper isolates the cost: it materialises
 * for the few hundred ms it takes to round-trip to the Ollama (or
 * Claude bridge) endpoint, writes the parsed response to
 * /Temp/ai-fetch-res.json, and exits.
 *
 * Request shape (/Temp/ai-fetch-req.json):
 *   { _reqId, url, method?, headers?, body?, timeoutMs? }
 *
 * Response shape (/Temp/ai-fetch-res.json):
 *   { _reqId, ok, status?, text?, error? }
 */

const REQ = "/Temp/ai-fetch-req.json";
const RES = "/Temp/ai-fetch-res.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let req;
  try { req = JSON.parse(ns.read(REQ)); }
  catch (e) {
    write(ns, { ok: false, error: "bad request: " + String(e) });
    return;
  }

  const timeoutMs = Number(req.timeoutMs) || 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(req.url, {
      method:  req.method  || "POST",
      headers: req.headers || { "Content-Type": "application/json" },
      body:    req.body,
      signal:  controller.signal
    });
    const text = await r.text();
    write(ns, {
      _reqId: req._reqId || null,
      ok:     r.ok,
      status: r.status,
      text
    });
  } catch (e) {
    write(ns, {
      _reqId: req._reqId || null,
      ok:     false,
      error:  String(e.message || e)
    });
  } finally {
    clearTimeout(timer);
  }
}

function write(ns, payload) {
  try { ns.write(RES, JSON.stringify({ ts: Date.now(), ...payload }), "w"); }
  catch (_) {}
}
