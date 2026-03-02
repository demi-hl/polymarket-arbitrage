#!/bin/bash
# Kill any existing Polymarket dashboard/server/watch, then start only the dashboard.
cd "$(dirname "$0")/.."

echo "Stopping any existing polymarket processes..."
pkill -f "polymarket.js" 2>/dev/null || true
sleep 2

echo "Starting Polymarket dashboard..."
mkdir -p logs
nohup node polymarket.js dashboard --port 3002 > logs/dashboard.log 2>&1 &
PID=$!
echo "Dashboard PID: $PID"
echo "Dashboard: http://localhost:3002"
echo "Logs: tail -f logs/dashboard.log"
