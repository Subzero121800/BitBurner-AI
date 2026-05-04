This directory holds AI-authored scripts. The ollama-player can:
  • write_generated_script here
  • delete_generated_script here
  • run_script from here
  • copy_script from here to a rooted server

Protected files (scb.js, ollama-player.js, etc.) cannot be touched
directly — the AI must use propose_patch, then a human runs
/approve-patch.js to apply.
