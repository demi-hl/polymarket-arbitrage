#!/bin/bash

# Telegram PC Control Bot Startup Script
# Usage: ./start.sh [bot|worker|both]

MODE=${1:-bot}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

case "$MODE" in
    bot)
        echo "🤖 Starting Telegram Bot..."
        node bot.js
        ;;
    worker)
        echo "⚙️ Starting PC Worker..."
        node worker.js
        ;;
    both)
        echo "🚀 Starting both Bot and Worker..."
        node bot.js &
        BOT_PID=$!
        node worker.js &
        WORKER_PID=$!
        
        echo "Bot PID: $BOT_PID"
        echo "Worker PID: $WORKER_PID"
        
        # Wait for interrupt
        trap "kill $BOT_PID $WORKER_PID; exit" SIGINT SIGTERM
        wait
        ;;
    *)
        echo "Usage: $0 [bot|worker|both]"
        echo ""
        echo "Modes:"
        echo "  bot    - Start Telegram bot (run on MacBook)"
        echo "  worker - Start PC worker (run on PC)"
        echo "  both   - Start both (for testing)"
        exit 1
        ;;
esac
