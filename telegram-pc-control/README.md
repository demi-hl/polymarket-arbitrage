# Telegram PC Control Bot

Remote PC control via Telegram bot using a file-based queue bridge system. Tasks are submitted to a queue, synced via Syncthing to the PC, executed by a worker, and results are synced back.

## Architecture

```
┌──────────────┐      Telegram API      ┌──────────────┐
│   Telegram   │ ◄────────────────────► │   Bot (Mac)  │
│    Client    │                        │  bot.js      │
└──────────────┘                        └──────┬───────┘
                                               │
                                               │ Write task
                                               ▼
                                        ┌──────────────┐
                                        │ queue/pending│
                                        │  task.json   │
                                        └──────┬───────┘
                                               │
                                               │ Syncthing
                                               ▼
                                        ┌──────────────┐
                                        │queue/pending │
                                        │  task.json   │
                                        └──────┬───────┘
                                               │
                                               │ Worker reads
                                               ▼
                                        ┌──────────────┐
                                        │   Worker     │
                                        │  (PC)        │
                                        │ worker.js    │
                                        └──────┬───────┘
                                               │
                                               │ Execute
                                               ▼
                                        ┌──────────────┐
                                        │  Command     │
                                        │  nvidia-smi  │
                                        └──────┬───────┘
                                               │
                                               │ Write result
                                               ▼
                                        ┌──────────────┐
                                        │queue/completed│
                                        │  result.json │
                                        └──────┬───────┘
                                               │
                                               │ Syncthing
                                               ▼
                                        ┌──────────────┐
                                        │queue/completed│
                                        │  result.json │
                                        └──────┬───────┘
                                               │
                                               │ Bot reads
                                               ▼
                                        ┌──────────────┐
                                        │   Reply to   │
                                        │   Telegram   │
                                        └──────────────┘
```

## Installation

### 1. Setup Telegram Bot

1. Talk to [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot: `/newbot`
3. Get your bot token
4. Get your Telegram user ID from [@userinfobot](https://t.me/userinfobot)

### 2. MacBook Setup (Bot)

```bash
cd ~/clawd-local/agents/polymarket-arbitrage-bot/telegram-pc-control

# Install dependencies
npm install

# Copy and edit environment config
cp .env.example .env
# Edit .env with your bot token and user ID

# Start the bot
npm start
```

### 3. PC Setup (Worker)

```bash
cd ~/clawd-local/agents/polymarket-arbitrage-bot/telegram-pc-control

# Install dependencies (same folder)
npm install

# Copy and edit environment config
cp .env.example .env
# Edit .env - same queue path as MacBook

# Start the worker
npm run worker
```

### 4. Syncthing Setup

Ensure the queue folder is synced between MacBook and PC:

```
~/clawd-local/queue/
├── pending/
├── in-progress/
├── completed/
└── failed/
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/pc <command>` | Execute any command on PC | `/pc nvidia-smi` |
| `/pcstatus` | Check PC status (GPU, CPU, memory) | `/pcstatus` |
| `/pcstart <service>` | Start services | `/pcstart trading` |
| `/pcstop <service>` | Stop services | `/pcstop scanner` |
| `/pcqueue` | View pending queue tasks | `/pcqueue` |
| `/pcresults` | View completed task results | `/pcresults 10` |

### Service Names for /pcstart and /pcstop

- `trading` - Main trading bot
- `scanner` - Market opportunity scanner
- `dashboard` - Web monitoring dashboard
- `server` - API server
- `pm2` - PM2 process manager
- `discord` - Discord bot
- `all` - Stop all services (stop only)

## Safety Features

### Command Whitelisting

Only commands in the whitelist can be executed:
- System: `nvidia-smi`, `top`, `ps`, `df`, `free`, `uptime`
- Node: `node`, `npm`, `npx`
- Git: `git`
- PM2: `pm2`
- Network: `ping`, `curl`, `wget`, `netstat`
- Safe file ops: `find`, `du`, `stat`

### Blocked Patterns

These dangerous patterns are blocked:
- `rm -rf` commands
- Fork bombs
- Pipe-to-shell (`curl | sh`)
- Disk formatting commands
- `dd` with output

### Rate Limiting

- 1 command per 5 seconds per user
- Automatic cleanup of stale confirmations

### Destructive Command Confirmation

Commands like `kill`, `pkill`, `reboot`, `shutdown` require confirmation:
1. First attempt: Bot asks for confirmation
2. Send same command again within 30 seconds to confirm
3. Command executes

## Configuration

### Environment Variables

```env
# Required
TELEGRAM_PC_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_USERS=1426127634,123456789

# Optional
QUEUE_BRIDGE_PATH=/Users/demi/clawd-local/queue
PC_WORKING_DIR=/Users/demi/clawd-local/agents/polymarket-arbitrage-bot
```

### Adding Allowed Users

Multiple users can be authorized:
```env
TELEGRAM_ALLOWED_USERS=1426127634,987654321,555555555
```

## Running as Services

### Using PM2 (Recommended)

**MacBook (Bot):**
```bash
pm2 start bot.js --name telegram-pc-bot
```

**PC (Worker):**
```bash
pm2 start worker.js --name telegram-pc-worker
```

### Using systemd

Create `/etc/systemd/system/telegram-pc-bot.service`:
```ini
[Unit]
Description=Telegram PC Control Bot
After=network.target

[Service]
Type=simple
User=demi
WorkingDirectory=/home/demi/clawd-local/agents/polymarket-arbitrage-bot/telegram-pc-control
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Logs

Logs are stored in `logs/bot-YYYY-MM-DD.log`:

```bash
# View today's logs
npm run logs

# Or manually
tail -f logs/bot-$(date +%Y-%m-%d).log
```

## Troubleshooting

### Bot not responding
1. Check bot token is correct
2. Verify user ID is in ALLOWED_USERS
3. Check logs: `tail -f logs/bot-*.log`

### Commands timing out
1. Check Syncthing is syncing the queue folder
2. Verify worker is running on PC
3. Check worker logs

### Results not appearing
1. Verify Syncthing sync is working both ways
2. Check completed/ folder permissions
3. Restart worker if stuck

### Permission errors
Ensure the queue folders have correct permissions:
```bash
chmod -R 755 ~/clawd-local/queue
```

## Security Considerations

1. **Keep your bot token secret** - Anyone with the token can control the bot
2. **Limit allowed users** - Only add trusted Telegram user IDs
3. **Review command whitelist** - Add only commands you need
4. **Use firewall rules** - Restrict PC access if possible
5. **Monitor logs** - Regularly check for unauthorized attempts

## Development

### Adding New Commands

Edit `commands/pc.js` to add commands to the whitelist:

```javascript
const ALLOWED_COMMANDS = [
  // ... existing commands
  'your-new-command',
];
```

### Creating New Service Handlers

Edit `commands/pcstart.js` or `commands/pcstop.js`:

```javascript
const SERVICES = {
  // ... existing services
  myservice: {
    name: 'My Service',
    cmd: 'npm run myservice',
    workingDir: '~/my-project',
    description: 'My custom service'
  }
};
```

## License

MIT
