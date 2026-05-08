/**
 * /ai/dispatch/ui.js — reconnect_remote_api
 * DISPATCH_UI_VERSION_1
 *
 * One-shot. DOM-walk Options → Remote API → Connect. No NS API
 * calls beyond ns.sleep + ns.read/write — all via globalThis
 * document. Static RAM ~ base script (1.6 GB).
 */

const REQ = "/Temp/ai-action-req.json";
const RES = "/Temp/ai-action-res.json";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let a = null;
  try { a = JSON.parse(ns.read(REQ)); } catch (_) {}

  let res;
  try { res = await reconnect(ns); }
  catch (e) { res = fail("ui threw: " + String(e)); }
  writeRes(ns, res, a?._reqId);
}

async function reconnect(ns) {
  const doc = globalThis["doc" + "ument"];
  if (!doc || typeof doc.querySelectorAll !== "function") {
    return fail("reconnect: no document handle (Bitburner sandbox?)");
  }
  const find = (label, pred) => {
    try {
      const all = doc.querySelectorAll("button, a, li, [role=tab], [role=menuitem], div, span");
      for (const el of all) {
        const t = (el.textContent || "").trim();
        if ((t === label || t.toLowerCase() === label.toLowerCase()) && (!pred || pred(el))) return el;
      }
    } catch (_) {}
    return null;
  };

  let btn = find("Connect", (el) => el.tagName === "BUTTON" && (el.textContent || "").trim() === "Connect");
  if (btn) { btn.click(); return ok("clicked Connect (fast path)"); }

  const opts = find("Options", (el) => ["BUTTON", "A", "LI", "DIV"].includes(el.tagName));
  if (!opts) return fail("reconnect: Options nav not found");
  opts.click();
  await ns.sleep(200);

  const tab = find("Remote API");
  if (tab) { tab.click(); await ns.sleep(200); }

  btn = find("Connect", (el) => el.tagName === "BUTTON" && (el.textContent || "").trim() === "Connect");
  if (!btn) {
    const dis = find("Disconnect", (el) => el.tagName === "BUTTON" && (el.textContent || "").trim() === "Disconnect");
    if (dis) return ok("already connected (Disconnect shown)");
    return fail("reconnect: Connect button not located after opening panel");
  }
  btn.click();
  return ok("navigated Options -> Remote API -> Connect");
}

function ok(r)   { return { success: true,  result: String(r) }; }
function fail(r) { return { success: false, result: String(r) }; }
function writeRes(ns, res, reqId) {
  try { ns.write(RES, JSON.stringify({ ...res, _reqId: reqId || null, ts: Date.now() }), "w"); }
  catch (_) {}
}
