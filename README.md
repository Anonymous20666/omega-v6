# Omega V5 Professional Bot Platform

Production-ready multi-node WhatsApp automation platform with Telegram control plane, queue-driven broadcasting, Intel link ingestion/validation, and role-based command security.

## What This Project Provides

- Multi-node WhatsApp runtime (Baileys)
- Telegram operations dashboard (Telegraf)
- Queue engine for broadcast/status jobs (BullMQ + Redis)
- Intel link ingestion and controlled join workflows
- Owner/admin/public command model
- AI integrations and media utility modules
- PM2-compatible process deployment for VPS

## Architecture Overview

1. Runtime entrypoint: `index.js`
2. WhatsApp core: `core/whatsapp.js`
3. Telegram control plane: `core/telegram.js`
4. Queue engine: `core/bullEngine.js`
5. Command plugins: `plugins/*.js`
6. Persistent runtime state: `data/` (not for git)

## Prerequisites

- Linux VPS (Ubuntu 22.04+ recommended)
- Node.js 22 LTS (or minimum supported by current deps)
- npm 10+
- Redis 6+
- MongoDB 6+
- PM2
- ffmpeg
- yt-dlp

## 1) Server Bootstrap

```bash
sudo apt update
sudo apt install -y curl git ca-certificates build-essential ffmpeg redis-server
```

Install Node.js 22 (NodeSource):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Install PM2 globally:

```bash
sudo npm install -g pm2
pm2 -v
```

Install yt-dlp:

```bash
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

## 2) Redis Setup

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server
sudo systemctl status redis-server --no-pager
```

Optional password hardening:

```bash
sudo sed -i 's/^# \?requirepass .*/requirepass REPLACE_WITH_STRONG_PASSWORD/' /etc/redis/redis.conf
sudo systemctl restart redis-server
```

## 3) MongoDB Setup

Install MongoDB Community edition and ensure service is running:

```bash
sudo systemctl enable mongod
sudo systemctl start mongod
sudo systemctl status mongod --no-pager
```

Create application DB/user (example):

```bash
mongosh
use admin
db.createUser({
  user: "omega_bot",
  pwd: "REPLACE_WITH_STRONG_PASSWORD",
  roles: [{ role: "readWriteAnyDatabase", db: "admin" }]
})
exit
```

## 4) Clone and Install

```bash
git clone https://github.com/pappy999666-dotcom/Omega-v5-test.git
cd Omega-v5-test
npm install
```

## 5) Environment Configuration

Create `.env` from your template and set all required variables:

```bash
cp .env.example .env
nano .env
```

At minimum, configure:

- WhatsApp owner identifiers
- Telegram bot token and owner Telegram ID
- MongoDB URI
- Redis host/port/password
- Any AI provider keys you actually use

Important:

- Never commit `.env`
- Never commit `data/sessions/`
- Never commit runtime JSON state files

## 6) Preflight Validation

Run syntax checks across JS sources before first start:

```bash
find . -type f -name "*.js" -not -path "./node_modules/*" -print0 | xargs -0 -I{} node -c "{}"
```

If command returns no output and exit code 0, syntax is healthy.

## 7) Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 status
```

Optional startup persistence:

```bash
pm2 startup
# run command printed by pm2 startup, then:
pm2 save
```

## 8) Pairing and First Use

1. Open Telegram bot and run `/start`
2. Use node deployment controls from Telegram panel
3. Pair WhatsApp number via generated pairing flow
4. Confirm node online status from Telegram hub

## 9) Operational Safety Recommendations

- Keep Intel auto-join in queue mode by default
- Avoid enabling aggressive realtime joins permanently
- Keep broadcast concurrency conservative on new numbers
- Monitor PM2 logs during campaigns
- Use owner-only controls for queue wipes and node restarts

## 10) Useful Runtime Commands

```bash
pm2 status
pm2 logs omega-v5-test --lines 200
pm2 restart omega-v5-test
pm2 describe omega-v5-test
```

Quick health checks:

```bash
node -c index.js
node -c core/telegram.js
node -c core/whatsapp.js
```

## 11) Git Hygiene and Safe Push Workflow

Check auth and repo state:

```bash
gh auth status
git status
git remote -v
```

Commit and push:

```bash
git add .
git commit -m "chore: production hardening and documentation update"
git push origin main
```

If your default branch is not `main`, push to the active branch shown by `git branch --show-current`.

## 12) What Must Stay Ignored

This repository intentionally excludes runtime-sensitive state, including:

- `.env`
- `data/sessions/`
- local runtime caches and logs
- per-node Intel cycle and join state
- personally identifying Telegram/owner runtime state

Review `.gitignore` before every push if you add new runtime files.

## Troubleshooting

Issue: bot starts but Telegram actions fail

1. Verify `TG_BOT_TOKEN`
2. Ensure no competing poller with same token is running
3. Check `pm2 logs omega-v5-test --lines 200`

Issue: Intel join appears slow to start

1. Check validator status in Telegram join panel
2. Inspect queue and cycle state under `data/`
3. Confirm node is online and not in safety pause

Issue: push to GitHub fails

1. Run `gh auth status`
2. Run `git remote -v`
3. Resolve branch protections or permissions on GitHub

## License

Private/Project-specific unless explicitly relicensed by repository owner.
