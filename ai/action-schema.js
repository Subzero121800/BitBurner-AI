/**
 * /ai/action-schema.js — pure data and validation, zero NS surface
 * SCHEMA_VERSION_2
 *
 * No netscript references appear in this file - not in code, comments,
 * or string literals. The static RAM cost imported by callers is 0 GB.
 *
 * Importers:
 *   /ollama-player.js
 *   /helpers/* (when they need DISPATCH_MAP routing)
 *
 * Companion file /ollama-actions.js is kept as a deprecated re-export
 * shim for any older consumer; new code should import from here.
 */

export const ACTION_SCHEMA = [
  { action: "hack",        args: ["target"],            desc: "Deploy hack workers" },
  { action: "grow",        args: ["target"],            desc: "Deploy grow workers" },
  { action: "weaken",      args: ["target"],            desc: "Deploy weaken workers" },
  { action: "deploy_hack", args: ["target", "server"],  desc: "Split deploy on a server" },

  { action: "travel",   args: ["city"],   desc: "Travel to a city" },
  { action: "connect",  args: ["server"], desc: "Connect terminal to a server" },
  { action: "backdoor", args: ["server"], desc: "Install a backdoor" },

  { action: "work_company", args: ["company"],          desc: "Work at a company" },
  { action: "work_faction", args: ["faction", "type"],  desc: "Work for a faction" },
  { action: "study",        args: ["course", "place"],  desc: "Take a university course" },
  { action: "gym",          args: ["stat", "place"],    desc: "Train a stat at a gym" },
  { action: "commit_crime", args: ["crime"],            desc: "Commit a crime" },

  { action: "buy_program",      args: ["program"],         desc: "Buy a hacking program" },
  { action: "buy_server",       args: ["ram"],             desc: "Purchase a new server" },
  { action: "upgrade_server",   args: ["server", "ram"],   desc: "Upgrade a purchased server" },
  { action: "buy_augmentation", args: ["faction", "aug"],  desc: "Buy an augmentation" },
  { action: "buy_hacknet_node", args: [],                  desc: "Buy a hacknet node" },
  { action: "upgrade_hacknet",  args: ["node", "type"],    desc: "Upgrade a hacknet node" },

  { action: "join_faction",   args: ["faction"],            desc: "Accept a faction invite" },
  { action: "donate_faction", args: ["faction", "amount"],  desc: "Donate to a faction" },

  { action: "sleeve_task", args: ["sleeve", "task"], desc: "Assign a sleeve task" },

  { action: "gang_recruit", args: [],                  desc: "Recruit a gang member" },
  { action: "gang_assign",  args: ["member", "task"],  desc: "Assign a gang member task" },
  { action: "gang_ascend",  args: ["member"],          desc: "Ascend a gang member" },

  { action: "bb_action", args: ["type", "name"], desc: "Start a BB action" },
  { action: "bb_skill",  args: ["skill"],        desc: "Upgrade a BB skill" },

  { action: "install_augmentations", args: [],     desc: "Install queued augs and reset" },
  { action: "soft_reset",            args: [],     desc: "Soft reset" },
  { action: "wait",                  args: ["ms"], desc: "Sleep for milliseconds" },
  { action: "noop",                  args: [],     desc: "Do nothing" },

  { action: "read_file",              args: ["path"],                                  desc: "Read a file" },
  { action: "list_files",             args: ["prefix?"],                               desc: "List files" },
  { action: "write_generated_script", args: ["path", "content"],                       desc: "Write a script under an allowed dir" },
  { action: "delete_generated_script",args: ["path"],                                  desc: "Delete a script under an allowed dir" },
  { action: "run_script",             args: ["script", "host?", "threads?", "argv?"], desc: "Run a script under an allowed dir" },
  { action: "kill_script",            args: ["script", "host?"],                       desc: "Kill instances of a script" },
  { action: "copy_script",            args: ["script", "dst_host"],                    desc: "Copy a script from home to dst" },
  { action: "propose_patch",          args: ["target", "content", "reason"],           desc: "Propose a patch to a protected file" },

  { action: "set_sleeve_plan",      args: ["plan"], desc: "Steer the sleeve manager" },
  { action: "set_gang_plan",        args: ["plan"], desc: "Steer the gang manager" },
  { action: "set_bladeburner_plan", args: ["plan"], desc: "Steer the bladeburner manager" },
  { action: "set_darknet_plan",     args: ["plan"], desc: "Steer the darknet manager" },

  { action: "darknet_probe",        args: [],                                      desc: "List darknet neighbours" },
  { action: "darknet_authenticate", args: ["host", "password?"],                   desc: "Crack a darknet server" },
  { action: "darknet_heartbleed",   args: ["host", "threads?", "peek?"],           desc: "Heartbleed exploit" },
  { action: "darknet_phishing",     args: ["threads?"],                            desc: "Phishing attack from a darknet server" },
  { action: "darknet_memreal",      args: ["host"],                                desc: "Memory reallocation" },
  { action: "darknet_migrate",      args: ["host", "threads?"],                    desc: "Induce server migration" },
  { action: "darknet_stasis_set",   args: ["host"],                                desc: "Pin a server with a stasis link" },
  { action: "darknet_open_cache",   args: ["filename", "suppressToast?"],          desc: "Open a .cache file" },
  { action: "darknet_pumpdump",     args: ["symbol", "threads?"],                  desc: "Pump/dump a stock for volatility" }
];

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

  darknet_probe: "darknet", darknet_authenticate: "darknet",
  darknet_heartbleed: "darknet", darknet_phishing: "darknet",
  darknet_memreal: "darknet", darknet_migrate: "darknet",
  darknet_stasis_set: "darknet", darknet_open_cache: "darknet",
  darknet_pumpdump: "darknet",

  noop: "inline", wait: "inline",
  set_sleeve_plan: "inline", set_gang_plan: "inline", set_bladeburner_plan: "inline",
  set_darknet_plan: "inline"
};

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
