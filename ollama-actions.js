/**
 * ollama-actions.js — AI Action Schema (zero-RAM library)
 * ACTIONS_VERSION_5_SCHEMA_ONLY
 *
 * As of v5 this file is intentionally NS-call-free. The previous
 * monolithic executeAction dispatcher was inflating ollama-player.js
 * to ~131 GB statically because every imported NS reference (singularity,
 * sleeve, gang, hacknet, bladeburner, cloud) was rolled into the
 * importing script's RAM ledger. The implementations now live in
 * /ai/dispatch/<category>.js and are invoked via ns.exec, so each
 * namespace pays its own RAM bill only while running.
 *
 * What still lives here:
 *   • ACTION_SCHEMA   — pure data; the contract surfaced to the model.
 *   • DISPATCH_MAP    — action.action -> dispatcher category.
 *   • INLINE_ACTIONS  — actions the player handles itself (no exec).
 *   • validateAction  — pure JS; checks shape only.
 *
 * Importing this file from anywhere costs ~0 GB (ns.tprint in main is
 * the only reachable NS surface and it's free).
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.tprint("INFO  ollama-actions.js is a schema/validator library, not a runnable script.");
  ns.tprint("INFO  It exports ACTION_SCHEMA / DISPATCH_MAP / INLINE_ACTIONS / validateAction.");
  if (ns.args.includes("--list")) {
    ns.tprint("");
    ns.tprint("Available actions (" + ACTION_SCHEMA.length + "):");
    for (const a of ACTION_SCHEMA) {
      const args = a.args.length ? " <" + a.args.join("> <") + ">" : "";
      const cat  = DISPATCH_MAP[a.action] || (INLINE_ACTIONS.has(a.action) ? "inline" : "?");
      ns.tprint("  [" + cat.padEnd(11) + "] " + a.action + args + " — " + a.desc);
    }
  }
}

export const ACTION_SCHEMA = [
  { action: "hack",   args: ["target"], desc: "Deploy hack workers against target using best available RAM" },
  { action: "grow",   args: ["target"], desc: "Deploy grow workers against target using best available RAM" },
  { action: "weaken", args: ["target"], desc: "Deploy weaken workers against target using best available RAM" },
  { action: "deploy_hack", args: ["target", "server"], desc: "Deploy weaken/grow/hack split. If server is full, auto-picks better server" },

  { action: "travel",   args: ["city"],   desc: "Travel to a city" },
  { action: "connect",  args: ["server"], desc: "Connect terminal to a server" },
  { action: "backdoor", args: ["server"], desc: "Install backdoor on a server" },

  { action: "work_company", args: ["company"],          desc: "Work at company for pay/rep" },
  { action: "work_faction", args: ["faction", "type"],  desc: "Work for faction. type: hacking | field | security" },
  { action: "study",        args: ["course", "university"], desc: "Take university course" },
  { action: "gym",          args: ["stat", "gym"],      desc: "Train stat at gym" },
  { action: "commit_crime", args: ["crime"],            desc: "Commit crime" },

  { action: "buy_program",      args: ["program"],         desc: "Buy hacking program from darkweb" },
  { action: "buy_server",       args: ["ram"],             desc: "Purchase new server" },
  { action: "upgrade_server",   args: ["server", "ram"],   desc: "Upgrade purchased server" },
  { action: "buy_augmentation", args: ["faction", "aug"],  desc: "Buy augmentation" },
  { action: "buy_hacknet_node", args: [],                  desc: "Buy hacknet node" },
  { action: "upgrade_hacknet",  args: ["node", "type"],    desc: "Upgrade hacknet level | ram | core" },

  { action: "join_faction",   args: ["faction"],            desc: "Accept faction invite" },
  { action: "donate_faction", args: ["faction", "amount"],  desc: "Donate to faction" },

  { action: "sleeve_task", args: ["sleeve", "task"], desc: "Assign sleeve task" },

  { action: "gang_recruit", args: [],                  desc: "Recruit gang member" },
  { action: "gang_assign",  args: ["member", "task"],  desc: "Assign gang member task" },
  { action: "gang_ascend",  args: ["member"],          desc: "Ascend gang member" },

  { action: "bb_action", args: ["type", "name"], desc: "Start Bladeburner action" },
  { action: "bb_skill",  args: ["skill"],        desc: "Upgrade Bladeburner skill" },

  { action: "install_augmentations", args: [],     desc: "Install queued augmentations and reset" },
  { action: "soft_reset",            args: [],     desc: "Soft reset" },
  { action: "wait",                  args: ["ms"], desc: "Sleep for milliseconds" },
  { action: "noop",                  args: [],     desc: "Do nothing" },

  // Filesystem / process — guard-railed in /ai/dispatch/fs.js
  { action: "read_file",              args: ["path"],                    desc: "Read a file (no path restrictions)" },
  { action: "list_files",             args: ["prefix?"],                 desc: "List files on home, optionally filtered by prefix (e.g. '/ai/')" },
  { action: "write_generated_script", args: ["path", "content"],         desc: "Write a script under /ai/generated/, /Temp/, /logs/, or /ai/scratch/" },
  { action: "delete_generated_script",args: ["path"],                    desc: "Delete a file under one of the AI-allowed dirs" },
  { action: "run_script",             args: ["script", "host?", "threads?", "argv?"], desc: "Run a script under an AI-allowed dir on home or any rooted server" },
  { action: "kill_script",            args: ["script", "host?"],         desc: "Kill all instances of a script (filename match) on a host" },
  { action: "copy_script",            args: ["script", "dst_host"],      desc: "Copy a script from home to dst_host (must be rooted)" },
  { action: "propose_patch",          args: ["target", "content", "reason"], desc: "Propose a change to a PROTECTED file. Writes /ai/patches/pending-patch.json — a human runs /approve-patch.js to apply" },

  // System health
  { action: "reconnect_remote_api",   args: [], desc: "Best-effort programmatic Options → Remote API → Connect via DOM. Use when state.systemHealth.syncStale is true." },

  // Manager directives — pure /Temp/ writes, handled inline in the player.
  { action: "set_sleeve_plan",      args: ["plan"], desc: "Steer sleeve-manager. plan = { default?:{task,...}, sleeves?:{ '0':{task,...} } }. Tasks: shock_recovery|synchronize|idle|commit_crime|gym|study|company_work|faction_work" },
  { action: "set_gang_plan",        args: ["plan"], desc: "Steer gang-manager. plan = { createFaction?, memberOverrides?:{name:task}, allowEquipment?:bool, warfareOverride?:bool|null }" },
  { action: "set_bladeburner_plan", args: ["plan"], desc: "Steer bladeburner-manager. plan = { actionOverride?:{type,name}, antiChaosThreshold?:number, skillPriorities?:[name,...] }" }
];

// Action -> /ai/dispatch/<category>.js (or "inline" for player-handled).
// Used by ollama-player.js to route execution. Pure data; no NS.
export const DISPATCH_MAP = {
  hack: "deploy", grow: "deploy", weaken: "deploy", deploy_hack: "deploy",

  travel: "singularity", connect: "singularity", backdoor: "singularity",
  work_company: "singularity", work_faction: "singularity",
  study: "singularity", gym: "singularity", commit_crime: "singularity",
  buy_program: "singularity", buy_augmentation: "singularity",
  join_faction: "singularity", donate_faction: "singularity",
  install_augmentations: "singularity", soft_reset: "singularity",

  buy_server: "cloud", upgrade_server: "cloud",

  sleeve_task: "sleeve",

  gang_recruit: "gang", gang_assign: "gang", gang_ascend: "gang",

  buy_hacknet_node: "hacknet", upgrade_hacknet: "hacknet",

  bb_action: "blade", bb_skill: "blade",

  read_file: "fs", list_files: "fs",
  write_generated_script: "fs", delete_generated_script: "fs",
  run_script: "fs", kill_script: "fs", copy_script: "fs",
  propose_patch: "fs",

  reconnect_remote_api: "ui",

  // Inline (handled in the player; no exec):
  noop: "inline", wait: "inline",
  set_sleeve_plan: "inline", set_gang_plan: "inline", set_bladeburner_plan: "inline"
};

// Convenience set for inline-only actions.
export const INLINE_ACTIONS = new Set(
  Object.entries(DISPATCH_MAP).filter(([, v]) => v === "inline").map(([k]) => k)
);

const VALID_ACTIONS = new Set(ACTION_SCHEMA.map((a) => a.action));

export function validateAction(action) {
  if (!action || typeof action !== "object") return { ok: false, reason: "not an object" };
  if (typeof action.action !== "string")     return { ok: false, reason: "missing .action" };
  if (!VALID_ACTIONS.has(action.action))     return { ok: false, reason: "unknown action: " + action.action };
  return { ok: true };
}
