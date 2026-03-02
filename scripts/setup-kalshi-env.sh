#!/bin/bash
# Create .env with Kalshi vars and lock permissions. Add your key/secret manually.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  touch .env
  echo "Created .env"
fi

# Append only if not already present
grep -q '^KALSHI_API_KEY=' .env 2>/dev/null || echo 'KALSHI_API_KEY=your-api-key-id-here' >> .env
grep -q '^KALSHI_PRIVATE_KEY_PATH=' .env 2>/dev/null || echo 'KALSHI_PRIVATE_KEY_PATH=.kalshi-private.pem' >> .env

chmod 600 .env
echo "chmod 600 .env done."
echo ""
echo "Next:"
echo "  1. Edit .env and set KALSHI_API_KEY to your API Key ID."
echo "  2. Either:"
echo "     - Put your RSA private key in .kalshi-private.pem and set KALSHI_PRIVATE_KEY_PATH=.kalshi-private.pem"
echo "     - Or set KALSHI_API_SECRET=\"-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\" (use \\n for newlines)"
echo "  3. chmod 600 .kalshi-private.pem if using a key file."
