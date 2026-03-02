#!/bin/bash
# Show bot status and recent log activity (same as start-both-bots.sh --status + tail).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Processes ==="
pgrep -fl "polymarket.js" 2>/dev/null || echo "  (none)"
echo ""

echo "=== Log sizes ==="
for f in logs/bot-a.log logs/bot-b.log logs/conway.log logs/dashboard.log; do
  if [[ -f "$ROOT/$f" ]]; then
    printf "  %-20s %6s lines\n" "$f" "$(wc -l < "$ROOT/$f")"
  fi
done
echo ""

echo "=== Last 5 lines: bot-a ==="
tail -5 logs/bot-a.log 2>/dev/null || echo "  (no log)"
echo ""
echo "=== Last 5 lines: bot-b ==="
tail -5 logs/bot-b.log 2>/dev/null || echo "  (no log)"
