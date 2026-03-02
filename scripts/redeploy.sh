#!/bin/bash
cd "$(dirname "$0")/.."

echo "[$(date)] Snapshotting API data..."
curl -s http://localhost:3002/api/status > public/data/status.json 2>/dev/null
curl -s http://localhost:3002/api/strategies > public/data/strategies.json 2>/dev/null
curl -s http://localhost:3002/api/accounts/compare > public/data/accounts-compare.json 2>/dev/null
curl -s http://localhost:3002/api/accounts/A/portfolio > public/data/accounts-A-portfolio.json 2>/dev/null
curl -s http://localhost:3002/api/accounts/B/portfolio > public/data/accounts-B-portfolio.json 2>/dev/null
curl -s "http://localhost:3002/api/opportunities?threshold=5" > public/data/opportunities.json 2>/dev/null

# Verify data is valid JSON before deploying
if python3 -c "import json; json.load(open('public/data/accounts-compare.json'))" 2>/dev/null; then
  echo "[$(date)] Data valid. Building..."
  npm run build --silent 2>/dev/null
  echo "[$(date)] Deploying to Vercel..."
  npx vercel deploy --prod --yes 2>&1 | tail -3
  echo "[$(date)] Done."
else
  echo "[$(date)] Dashboard not responding, skipping deploy."
fi
