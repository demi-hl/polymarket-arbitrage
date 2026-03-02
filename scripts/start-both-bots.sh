#!/bin/bash
# Polymarket + Conway bot control
# Usage:
#   ./start-both-bots.sh              # Start single Polymarket paper-trading bot (and Conway if configured)
#   ./start-both-bots.sh --conway-only      # Start only Conway (cross-market)
#   ./start-both-bots.sh --polymarket-only  # Start only Polymarket paper-trading bot
#   ./start-both-bots.sh --stop             # Stop all bots
#   ./start-both-bots.sh --status           # Show status
#   ./start-both-bots.sh --dashboard        # Start dashboard
#   ./start-both-bots.sh --force            # Stop then start (Polymarket paper-trading bot)

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
LOG_DIR="$ROOT/logs"
MAX_RESTARTS="${MAX_RESTARTS:-5}"
RESTART_DELAY="${RESTART_DELAY:-5}"

# Process names we manage (for --stop / --status)
POLYMARKET_WATCH="polymarket.js watch"
POLYMARKET_DASHBOARD="polymarket.js dashboard"
CONWAY_PATTERN="${CONWAY_PROCESS_PATTERN:-conway.*watch}"   # optional: set CONWAY_PROCESS_PATTERN if you have a Conway process

log() {
  local level="${1:-INFO}"
  shift
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
}

start_bot_with_restart() {
  local bot_name="$1"
  local cmd="$2"
  local log_file="$3"

  mkdir -p "$LOG_DIR"
  touch "$log_file"

  (
    local restart_count=0
    log "INFO" "Starting $bot_name with auto-restart protection..."

    while [[ $restart_count -lt $MAX_RESTARTS ]]; do
      eval "$cmd" >> "$log_file" 2>&1 &
      local pid=$!
      echo "$pid" > "/tmp/${bot_name}.pid"

      wait "$pid"
      local exit_code=$?

      # Clean shutdown (exit 0 or SIGINT 130)
      if [[ $exit_code -eq 0 || $exit_code -eq 130 ]]; then
        log "INFO" "$bot_name exited cleanly"
        exit 0
      fi

      restart_count=$((restart_count + 1))
      log "WARN" "$bot_name crashed (exit $exit_code). Restart $restart_count/$MAX_RESTARTS in ${RESTART_DELAY}s..."
      sleep "$RESTART_DELAY"
    done

    log "ERROR" "$bot_name exceeded max restarts. Giving up."
    exit 1
  ) &

  local supervisor_pid=$!
  echo "$supervisor_pid" > "/tmp/${bot_name}.supervisor.pid"
  echo "  Supervisor PID: $supervisor_pid"
}

do_stop() {
  echo "Stopping bots..."
  pkill -f "$POLYMARKET_WATCH" 2>/dev/null || true
  pkill -f "$CONWAY_PATTERN" 2>/dev/null || true
  if [[ "$1" == "all" ]]; then
    pkill -f "$POLYMARKET_DASHBOARD" 2>/dev/null || true
  fi
  sleep 2
  echo "Stopped."
}

do_stop_watch_only() {
  pkill -f "$POLYMARKET_WATCH" 2>/dev/null || true
  pkill -f "$CONWAY_PATTERN" 2>/dev/null || true
  sleep 2
}

do_status() {
  echo "=== Bot status ==="
  local found=0
  while read -r pid cmd; do
    [[ -z "$pid" ]] && continue
    echo "  PID $pid  $cmd"
    found=1
  done < <(pgrep -fl "polymarket.js" 2>/dev/null || true)
  if [[ $found -eq 0 ]]; then
    echo "  (no Polymarket processes running)"
  fi
  echo ""
  echo "Logs:"
  for f in logs/bot-paper.log logs/conway.log logs/dashboard.log; do
    if [[ -f "$ROOT/$f" ]]; then
      echo "  $f  ($(wc -l < "$ROOT/$f") lines)"
    fi
  done
}

do_dashboard() {
  echo "Starting dashboard..."
  nohup node polymarket.js dashboard --port 3002 > logs/dashboard.log 2>&1 &
  echo "  PID: $!"
  echo "  URL: http://localhost:3002"
  echo "  Logs: tail -f logs/dashboard.log"
}

start_polymarket() {
  # Single paper-trading account with jitter/backoff/rotation for API stability.
  echo "Starting Polymarket Paper Trading (edge >= 1.0%, jittered 120-300s)..."
  start_bot_with_restart "polymarket-paper" \
    "ACCOUNT_ID=paper MIN_EDGE=1.0 SCAN_INTERVAL=180000 SCAN_MIN_MS=120000 SCAN_MAX_MS=300000 SCAN_BACKOFF_ON_429_MS=120000 SCAN_MAX_BACKOFF_MS=600000 SCAN_INTER_REQUEST_DELAY_MS=600 STRATEGY_ROTATION=true STRATEGY_BATCH_SIZE=9 POSITION_SIZE=250 AUTO_EXECUTE=true node polymarket.js watch" \
    "$LOG_DIR/bot-paper.log"
  echo "  Logs: tail -f logs/bot-paper.log"
}

start_conway() {
  if [[ -n "$CONWAY_SCRIPT" && -x "$ROOT/$CONWAY_SCRIPT" ]]; then
    echo "Starting Conway (cross-market)..."
    start_bot_with_restart "conway" "\"$ROOT/$CONWAY_SCRIPT\"" "$LOG_DIR/conway.log"
    echo "  Logs: tail -f logs/conway.log"
  elif [[ -n "$CONWAY_CMD" ]]; then
    echo "Starting Conway (cross-market)..."
    start_bot_with_restart "conway" "env $CONWAY_CMD" "$LOG_DIR/conway.log"
  else
    echo "Conway (cross-market) not configured. Set CONWAY_SCRIPT or CONWAY_CMD to enable."
    echo "  e.g. export CONWAY_SCRIPT=scripts/conway-watch.sh"
  fi
}

# Parse flags
case "${1:-}" in
  --stop)
    do_stop all
    exit 0
    ;;
  --status)
    do_status
    exit 0
    ;;
  --dashboard)
    do_dashboard
    exit 0
    ;;
  --force)
    do_stop_watch_only
    start_polymarket
    echo ""
    echo "Polymarket paper-trading bot restarted."
    exit 0
    ;;
  --conway-only)
    do_stop all
    sleep 2
    start_conway
    exit 0
    ;;
  --polymarket-only)
    do_stop_watch_only
    start_polymarket
    echo ""
    echo "Polymarket-only: paper-trading bot started."
    exit 0
    ;;
  --help|-h)
    echo "Usage: $0 [option]"
    echo "  (no option)   Start Polymarket paper-trading bot (and Conway if CONWAY_SCRIPT/CONWAY_CMD set)"
    echo "  --conway-only       Start only Conway (cross-market)"
    echo "  --polymarket-only  Start only Polymarket paper-trading bot"
    echo "  --stop             Stop all bots and dashboard"
    echo "  --status           Show status (PIDs, logs)"
    echo "  --dashboard        Start dashboard (port 3002)"
    echo "  --force            Stop then start Polymarket paper-trading bot"
    echo "  --help             This help"
    exit 0
    ;;
  "")
    # Default: stop existing watch (keep dashboard), start Polymarket paper-trading bot, then Conway if configured
    do_stop_watch_only
    start_polymarket
    start_conway
    echo ""
    echo "Started. Use --status to check, --stop to stop."
    exit 0
    ;;
  *)
    echo "Unknown option: $1. Use --help."
    exit 1
    ;;
esac
