# GitHub Upload & Deployment Guide

## 📤 Uploading to GitHub

### Step 1: Create GitHub Repository
1. Go to https://github.com/new
2. Repository name: `omega-v5` (or your preferred name)
3. Description: "Advanced multi-node WhatsApp bot with AI integration"
4. **Keep it Private** (recommended for security)
5. **DO NOT** initialize with README (we already have one)
6. Click "Create repository"

### Step 2: Push to GitHub
```bash
cd /root/omega-v5

# Add your GitHub repository as remote
git remote add origin https://github.com/YOUR_USERNAME/omega-v5.git

# Push to GitHub
git branch -M main
git push -u origin main
```

**Note:** You'll need a GitHub Personal Access Token for authentication:
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `repo` scope
3. Use token as password when pushing

### Alternative: Using SSH
```bash
# Generate SSH key if you don't have one
ssh-keygen -t ed25519 -C "your_email@example.com"

# Add SSH key to GitHub
cat ~/.ssh/id_ed25519.pub
# Copy output and add to GitHub Settings → SSH Keys

# Add remote with SSH
git remote add origin git@github.com:YOUR_USERNAME/omega-v5.git
git push -u origin main
```

---

## 🚀 Deploying on New Server

### Quick Deployment Script

```bash
#!/bin/bash
# Save as deploy.sh and run: bash deploy.sh

echo "🚀 Omega V5 Deployment Script"
echo "=============================="

# Update system
echo "📦 Updating system..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 22
echo "📦 Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install MongoDB
echo "📦 Installing MongoDB..."
sudo apt install -y mongodb
sudo systemctl start mongodb
sudo systemctl enable mongodb

# Install Redis
echo "📦 Installing Redis..."
sudo apt install -y redis-server
sudo systemctl start redis
sudo systemctl enable redis

# Install system dependencies
echo "📦 Installing system dependencies..."
sudo apt install -y ffmpeg git

# Install yt-dlp
echo "📦 Installing yt-dlp..."
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Install PM2
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Clone repository
echo "📥 Cloning repository..."
cd ~
git clone https://github.com/YOUR_USERNAME/omega-v5.git
cd omega-v5

# Install dependencies
echo "📦 Installing Node dependencies..."
npm install

# Setup environment
echo "⚙️ Setting up environment..."
cp .env.example .env
echo ""
echo "⚠️  IMPORTANT: Edit .env file with your credentials"
echo "Run: nano .env"
echo ""

# Setup MongoDB user
echo "📊 Setting up MongoDB..."
mongosh <<EOF
use admin
db.createUser({
  user: "pappybot",
  pwd: "CHANGE_THIS_PASSWORD",
  roles: [{ role: "readWrite", db: "PappyUltimate2" }]
})
exit
EOF

# Setup Redis password
echo "🔒 Setting up Redis..."
echo "Edit /etc/redis/redis.conf and set: requirepass YOUR_PASSWORD"
echo "Then run: sudo systemctl restart redis"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file: nano .env"
echo "2. Configure Redis password: sudo nano /etc/redis/redis.conf"
echo "3. Restart Redis: sudo systemctl restart redis"
echo "4. Start bot: pm2 start ecosystem.config.js"
echo "5. Save PM2: pm2 save"
echo "6. Setup PM2 startup: pm2 startup"
```

---

## 📋 Manual Deployment Steps

### 1. Prerequisites
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version  # Should show v22.x.x
npm --version
```

### 2. Install Databases
```bash
# MongoDB
sudo apt install -y mongodb
sudo systemctl start mongodb
sudo systemctl enable mongodb

# Redis
sudo apt install -y redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

### 3. Install System Dependencies
```bash
# FFmpeg for media processing
sudo apt install -y ffmpeg

# yt-dlp for video downloads
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# PM2 for process management
sudo npm install -g pm2
```

### 4. Clone & Setup
```bash
# Clone repository
cd ~
git clone https://github.com/YOUR_USERNAME/omega-v5.git
cd omega-v5

# Install dependencies
npm install

# Setup environment
cp .env.example .env
nano .env  # Edit with your credentials
```

### 5. Configure Databases

**MongoDB:**
```bash
mongosh
use admin
db.createUser({
  user: "pappybot",
  pwd: "YOUR_SECURE_PASSWORD",
  roles: [{ role: "readWrite", db: "PappyUltimate2" }]
})
exit
```

**Redis:**
```bash
sudo nano /etc/redis/redis.conf
# Uncomment and set: requirepass YOUR_REDIS_PASSWORD
sudo systemctl restart redis
```

### 6. Start Bot
```bash
# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Run the command it outputs
```

---

## 🔧 Configuration

### Required .env Variables
```bash
# WhatsApp Owner
OWNER_WA_JID=2348012345678

# Telegram Bot
TG_BOT_TOKEN=your_bot_token_from_botfather
OWNER_TG_ID=your_telegram_user_id

# MongoDB
MONGO_URI=mongodb://pappybot:YOUR_PASSWORD@127.0.0.1:27017/PappyUltimate2?authSource=admin
MONGO_PASSWORD=YOUR_PASSWORD

# Redis
REDIS_PASSWORD=YOUR_REDIS_PASSWORD

# AI (at least one required)
DIGITALOCEAN_AI_KEY=your_digitalocean_key
# OR
OPENROUTER_API_KEY=your_openrouter_key
```

### Getting API Keys

**Telegram Bot Token:**
1. Message @BotFather on Telegram
2. Send `/newbot`
3. Follow instructions
4. Copy token

**Telegram User ID:**
1. Message @userinfobot on Telegram
2. Copy your ID

**DigitalOcean AI Key (Free Tier):**
1. Sign up at https://cloud.digitalocean.com/
2. Go to API → Tokens
3. Generate new token with AI scope

**OpenRouter Key:**
1. Sign up at https://openrouter.ai/
2. Go to Keys
3. Create new key

---

## 🔄 Updating Bot

```bash
cd ~/omega-v5

# Pull latest changes
git pull origin main

# Install new dependencies (if any)
npm install

# Restart bot
pm2 restart omega-v5
```

---

## 🛡️ Security Checklist

- [ ] Changed all default passwords in .env
- [ ] Set strong MongoDB password
- [ ] Set strong Redis password
- [ ] Repository is private on GitHub
- [ ] .env file is NOT committed to Git
- [ ] Firewall configured (allow only necessary ports)
- [ ] PM2 startup configured for auto-restart
- [ ] Regular backups of data/ directory

---

## 📊 Monitoring

```bash
# Check bot status
pm2 status

# View logs
pm2 logs omega-v5

# Monitor resources
pm2 monit

# Restart bot
pm2 restart omega-v5

# Stop bot
pm2 stop omega-v5
```

---

## 🆘 Troubleshooting

### Bot won't start
```bash
# Check logs
pm2 logs omega-v5 --lines 50

# Check MongoDB
sudo systemctl status mongodb

# Check Redis
sudo systemctl status redis

# Verify .env file
cat .env
```

### AI not working
```bash
# Test DigitalOcean AI key
curl -H "Authorization: Bearer YOUR_KEY" https://inference.do-ai.run/v1/models

# Check logs for AI errors
pm2 logs omega-v5 | grep AI
```

### WhatsApp disconnecting
```bash
# Clear sessions
rm -rf data/sessions/*/session-*

# Restart bot
pm2 restart omega-v5
```

---

## 📞 Support

- **Issues:** GitHub Issues
- **Telegram:** t.me/pappylung
- **Documentation:** See README.md

---

**Happy Deploying! 🚀**
