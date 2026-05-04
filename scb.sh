#!/usr/bin/env bash
#
# scb.sh — local-services launcher for the Bitburner workspace
#
# Default backend is Ollama, probed at 127.0.0.1:11434 by default.
# Add LAN endpoints (e.g. a Jetson) by dropping a JSON array into
# watch/ollama-candidates.json — see watch/ollama-candidates.example.json.
#
# The Claude bridge is OPT-IN: `./scb.sh start` does not launch it.
# Run `./scb.sh bridge` explicitly if you want Claude as the backend.
#
# Services:
#   1. bitburner-filesync — pushes saved files into the game over WS :12525
#   2. scb-watch           — file watcher: bumps /Temp/scb-restart.txt for
#                            the in-game hot-reload watchdog, probes
#                            available Ollama hosts, and writes the
#                            chosen one to /Temp/ollama-host.txt
#   3. claude-bridge       — (opt-in) proxy for /ollama-player.js that
#                            shells out to `claude -p`. Skipped by `start`
#
# Usage:
#   ./scb.sh start    — start all three
#   ./scb.sh stop     — stop all three
#   ./scb.sh restart  — stop then start
#   ./scb.sh status   — show pid + state
#   ./scb.sh logs     — tail all log files
#   ./scb.sh sync     — only the filesync watcher
#   ./scb.sh bridge   — only the Claude bridge
#   ./scb.sh watch    — only the file watcher
#   ./scb.sh sync-all — touch every game-bound file so filesync
#                       re-pushes all of them to the connected game
#
set -euo pipefail
cd "$(dirname "$0")"

RUN_DIR="$PWD/.run"
SYNC_LOG="$RUN_DIR/sync.log"
BRIDGE_LOG="$RUN_DIR/bridge.log"
WATCH_LOG="$RUN_DIR/watch.log"
SYNC_PID="$RUN_DIR/sync.pid"
BRIDGE_PID="$RUN_DIR/bridge.pid"
WATCH_PID="$RUN_DIR/watch.pid"

mkdir -p "$RUN_DIR"

c_red()   { printf "\033[31m%s\033[0m\n" "$*"; }
c_green() { printf "\033[32m%s\033[0m\n" "$*"; }
c_yel()   { printf "\033[33m%s\033[0m\n" "$*"; }
c_blue()  { printf "\033[34m%s\033[0m\n" "$*"; }

is_alive() {
  local pid_file=$1
  [[ -f $pid_file ]] || return 1
  local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "")
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null
}

# After a backgrounded npx/npm wrapper starts, $! is the wrapper's PID,
# not the underlying node child that actually holds the listening port.
# Replace the pidfile contents with the real child so `stop` doesn't
# orphan it.
resolve_to_child() {
  local pid_file=$1 wrapper_pid child_pid
  [[ -f $pid_file ]] || return 0
  wrapper_pid=$(cat "$pid_file" 2>/dev/null || echo "")
  [[ -n $wrapper_pid ]] || return 0
  for _ in 1 2 3 4 5; do
    child_pid=$(pgrep -P "$wrapper_pid" 2>/dev/null | head -1 || true)
    [[ -n $child_pid ]] && break
    sleep 0.2
  done
  if [[ -n $child_pid ]]; then
    echo "$child_pid" > "$pid_file"
  fi
}

start_sync() {
  if is_alive "$SYNC_PID"; then
    c_yel "filesync already running (pid $(cat "$SYNC_PID"))"
    return 0
  fi
  c_blue "starting bitburner-filesync on :12525..."
  ( npx --yes bitburner-filesync >"$SYNC_LOG" 2>&1 & echo $! >"$SYNC_PID" )
  sleep 1
  resolve_to_child "$SYNC_PID"
  if is_alive "$SYNC_PID"; then
    c_green "filesync up (pid $(cat "$SYNC_PID")) — log: $SYNC_LOG"
    c_yel   "now click Connect in the in-game Remote API panel"
  else
    c_red "filesync failed to start — see $SYNC_LOG"
    return 1
  fi
}

start_bridge() {
  # Optional overrides from bridge/.env (PORT, CLAUDE_MODEL, CLAUDE_BIN, etc.)
  if [[ -f bridge/.env ]]; then
    set -a; . bridge/.env; set +a
  fi
  if ! command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then
    c_yel "skipping bridge — '${CLAUDE_BIN:-claude}' not on PATH (install Claude Code first)"
    return 0
  fi
  if is_alive "$BRIDGE_PID"; then
    c_yel "bridge already running (pid $(cat "$BRIDGE_PID"))"
    return 0
  fi
  c_blue "starting claude-bridge on :${PORT:-3000} (using local Claude Code CLI)..."
  ( PORT="${PORT:-3000}" \
    CLAUDE_BIN="${CLAUDE_BIN:-claude}" \
    CLAUDE_MODEL="${CLAUDE_MODEL:-}" \
    CLAUDE_TIMEOUT_MS="${CLAUDE_TIMEOUT_MS:-90000}" \
    node bridge/claude-bridge.js >"$BRIDGE_LOG" 2>&1 & echo $! >"$BRIDGE_PID" )
  sleep 1
  if is_alive "$BRIDGE_PID"; then
    c_green "bridge up (pid $(cat "$BRIDGE_PID")) — log: $BRIDGE_LOG"
  else
    c_red "bridge failed to start — see $BRIDGE_LOG"
    return 1
  fi
}

start_watch() {
  if is_alive "$WATCH_PID"; then
    c_yel "watch already running (pid $(cat "$WATCH_PID"))"
    return 0
  fi
  c_blue "starting scb-watch (file watcher + heartbeat)..."
  ( PORT="${PORT:-3000}" \
    node watch/scb-watch.js >>"$WATCH_LOG" 2>&1 & echo $! >"$WATCH_PID" )
  sleep 1
  if is_alive "$WATCH_PID"; then
    c_green "watch up (pid $(cat "$WATCH_PID")) — log: $WATCH_LOG"
  else
    c_red "watch failed to start — see $WATCH_LOG"
    return 1
  fi
}

stop_one() {
  local pid_file=$1 name=$2
  if ! is_alive "$pid_file"; then
    c_yel "$name not running"
    rm -f "$pid_file"
    return 0
  fi
  local pid; pid=$(cat "$pid_file")
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  if kill -0 "$pid" 2>/dev/null; then
    c_red "force-killing $name (pid $pid)"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  c_green "stopped $name"
}

show_status() {
  for entry in "filesync:$SYNC_PID" "bridge:$BRIDGE_PID" "watch:$WATCH_PID"; do
    local name=${entry%%:*}
    local pf=${entry#*:}
    if is_alive "$pf"; then
      c_green "$name running (pid $(cat "$pf"))"
    elif [[ -f $pf ]]; then
      c_yel "$name pidfile stale"
    else
      printf "%s not running\n" "$name"
    fi
  done
}

case "${1:-start}" in
  start)
    start_sync
    start_watch
    # Claude bridge is opt-in. Backend defaults to Ollama (see
    # scb-watch's host detection). Run `./scb.sh bridge` to start it.
    if is_alive "$BRIDGE_PID"; then
      c_yel "claude-bridge still running — leaving it alone (use './scb.sh stop' to kill)"
    fi
    ;;
  stop)
    stop_one "$WATCH_PID"  watch
    stop_one "$BRIDGE_PID" bridge
    stop_one "$SYNC_PID"   filesync
    ;;
  restart)
    stop_one "$WATCH_PID"  watch
    stop_one "$BRIDGE_PID" bridge
    stop_one "$SYNC_PID"   filesync
    start_sync
    start_watch
    # Bridge intentionally NOT auto-started here; opt-in only.
    ;;
  status)  show_status ;;
  sync)    start_sync ;;
  bridge)  start_bridge ;;
  watch)   start_watch ;;
  sync-all)
    if ! is_alive "$SYNC_PID"; then
      c_red "filesync isn't running — start it first: ./scb.sh sync"
      exit 1
    fi
    c_blue "touching all .js / .script / .txt files (excluding service dirs)..."
    # Filesync's allowlist: .js .script .txt. Exclude our local-only
    # service dirs so we don't push the bridge / watcher Node code.
    count=$(find . -type f \( -name "*.js" -o -name "*.script" -o -name "*.txt" \) \
      ! -path "./node_modules/*" \
      ! -path "./.run/*" \
      ! -path "./bridge/*" \
      ! -path "./watch/*" \
      ! -path "./.vscode/*" \
      ! -path "./Temp/*" \
      ! -path "./.git/*" \
      ! -path "./Deprecated/*" \
      -print -exec touch {} + | wc -l | tr -d ' ')
    c_green "touched $count files — watch sync.log for pushes"
    sleep 2
    c_blue "tail of sync.log:"
    tail -20 "$SYNC_LOG" || true
    ;;
  logs)
    : > "$SYNC_LOG"; : > "$BRIDGE_LOG" 2>/dev/null || true
    : > "$WATCH_LOG" 2>/dev/null || true
    tail -f "$SYNC_LOG" "$BRIDGE_LOG" "$WATCH_LOG" 2>/dev/null
    ;;
  *)
    cat <<EOF
usage: $0 {start|stop|restart|status|logs|sync|bridge|watch|sync-all}

  start     start filesync + scb-watch (NOT bridge — opt-in)
  stop      stop all services (including bridge if running)
  restart   stop everything, then start filesync + watch
  status    show running pids
  logs      tail all log files (Ctrl-C to exit)
  sync      start only the filesync watcher
  bridge    start the Claude bridge (only if you want claude as backend)
  watch     start only the file watcher / hot-reload daemon
  sync-all  touch every .js/.script/.txt so filesync re-pushes them

Default backend is Ollama. scb-watch probes 127.0.0.1:11434 by default
and writes the first reachable host to /Temp/ollama-host.txt. To add
LAN candidates (Jetson, second box, etc.) drop a JSON array into
watch/ollama-candidates.json — see watch/ollama-candidates.example.json
for the format.

Logs: $RUN_DIR/{sync,bridge,watch}.log
EOF
    exit 2
    ;;
esac
