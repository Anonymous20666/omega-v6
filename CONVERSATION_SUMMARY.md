# Pappy Ultimate Bot - Conversation Summary

## Conversation Summary
- **Bot Not Responding & Rate-Limit Issues**: Bot was receiving WhatsApp messages but hitting rate-limit errors from WhatsApp due to excessive broadcasts and aggressive Intel join feature. Bot was working but temporarily blocked from sending messages.
- **Broadcast System Errors**: Fixed multiple issues including S3 backup spam, WhatsApp timeout errors, rate-limit handling, and incorrect package imports in broadcast media download.
- **Second Bot Deployment**: Created completely separate bot instance (bot2) in `/home/ubuntu/bot2/` with different Telegram token, separate database (PappyUltimate2), and fresh configuration to avoid rate-limits.
- **Self-Message and Private Message Blocking**: Removed filters that prevented bot from responding to its own messages and private messages.
- **Sudo Access Issue**: Changed sudo role to return 'owner' access level instead of 'sudo', giving sudo users full owner permissions.
- **AI Feature Improvements**: Enhanced image generation and text-to-speech with better error handling, validation, and increased timeouts.
- **Godcast Implementation Issues**: Attempted to implement Godcast feature from old working repo (symmetrical-train) to enable group status broadcasts with aesthetic templates. Multiple approaches tried including groupStatusMessage, gifted-baileys sendStatusToGroups, and status@broadcast methods.
- **Permission System Bug**: User role kept being overridden to 'admin' or 'public' despite being in sudo list, preventing access to owner commands like .godcast.

## Files and Code Summary
- **/home/ubuntu/bot/plugins/pappy-broadcast.js**: Contains 22 aesthetic templates for Godcast feature. Changed downloadMediaMessage import from gifted-baileys to @whiskeysockets/baileys. Increased broadcast delays from 3s to 4s, retry attempts from 1 to 2. Has commands: .gcast, .godcast, .stopcast, .schedulecast, .schedulegodcast, .loopcast, .loopgodcast, .listschedule, .cancelschedule.
- **/home/ubuntu/bot/core/bullEngine.js**: BullMQ broadcast worker. Queue name: 'pappy-ultimate-broadcast'. Increased timeouts from 20-25s to 30-35s. Handles ghost protocol, media delivery, and group status messages. Multiple iterations attempted to fix Godcast delivery using groupStatusMessage, status@broadcast, and gifted-baileys methods.
- **/home/ubuntu/bot2/core/bullEngine.js**: Separate queue name 'pappy-ultimate-broadcast-2' to prevent bot2 from controlling bot1.
- **/home/ubuntu/bot/services/sessionBackup.js**: Changed default USE_AWS from 'localstack' to 'false'. Made backup functions fail silently when S3 unavailable.
- **/home/ubuntu/bot/core/whatsapp.js**: Removed `if (msg.key.fromMe) return;` and `if (!isGroup) return;` filters to allow self-messages and private messages.
- **/home/ubuntu/bot/modules/permission.js**: Returns 'owner' for sudo users instead of 'sudo'.
- **/home/ubuntu/bot/modules/userEngine.js**: Manages user roles in MongoDB. Fixed to check ownerManager.isOwner() and ownerManager.isSudo() FIRST before any other role assignment, forcing 'owner' role for sudo users regardless of group admin status.
- **/home/ubuntu/bot/core/ai.js**: Enhanced generateImage() with 45s timeout, validation, and enhance=true parameter. Improved textToSpeech() with 25s timeout and validation.
- **/home/ubuntu/bot/plugins/pappy-core.js**: Menu command with 10 aesthetic templates and Pollinations image generation. Commands: .menu, .sys, .pappy, .img, .tts, .video, .sudo, .delsudo, .bind.
- **/home/ubuntu/bot/data/owner.json**: Contains owners (447781516554, 3197010576159) and sudo users (2348164167112).
- **/home/ubuntu/bot2/data/owner.json**: Contains owners (447781516554, 2347086278942).
- **/home/ubuntu/symmetrical-train/**: Old working bot repository cloned from GitHub (Anonymous20666/symmetrical-train) used as reference for fixing Godcast and other features.

## Key Insights
- **RATE-LIMIT ROOT CAUSE**: WhatsApp blocks bots from sending messages due to excessive broadcasts using `rate-overlimit` error. The bot processes commands but cannot send responses.
- **BOT ARCHITECTURE**: Bot uses PM2 for process management, Redis for queuing, MongoDB for data storage, BullMQ for broadcast queue management, and gifted-baileys for WhatsApp connection.
- **DUAL BOT SETUP**: Both bots run independently with separate Redis queue names (pappy-ultimate-broadcast vs pappy-ultimate-broadcast-2) and separate MongoDB databases (PappyUltimate vs PappyUltimate2).
- **GODCAST FEATURE**: Wraps links in 22 aesthetic templates with emojis and decorative text. Intended to send as group status messages but groupStatusMessage feature doesn't render properly in current Baileys version 6.7.5.
- **PERMISSION SYSTEM**: Three-tier system (owner > admin > public). Sudo users stored separately but should receive owner-level permissions. userEngine checks owner/sudo first, then admin, then public.
- **DATABASE**: MongoDB running in Docker container 'omega_db' at 172.18.0.1:27017 with credentials admin/OmegaDatabasePassword2026!
- **REDIS**: Running at 172.18.0.1:6379 with password PappyEliteRedis2026!
- **USER ROLE BUG**: userEngine.getOrCreate() was checking group admin status and overriding sudo users to 'admin' role, preventing access to owner commands.

## Most Recent Topic
**Topic**: Fixing watchdog restart loop (115 restarts) and rate-overlimit slowdown on bot1 (pappy-ultimate / symmetrical-train)

**Root Cause Found**:
- Number 234 (2347086278942) was logged out of WhatsApp and session was purged correctly
- BUT the Watchdog still held a reference to the 234 socket and kept calling `restartCallback()` every 2 minutes
- `startWhatsApp` was called for a non-existent session → `useMultiFileAuthState` tried to read `creds.json` from a deleted folder → ENOENT crash → PM2 restart → repeat (115 times)
- Separately, `.warn` and other commands were hitting WhatsApp `rate-overlimit` errors and crashing instead of backing off

**Fixes Applied**:
1. **watchdog.js** (all 3 bots): Added `detach(botId)` method + guard in `_check()` to verify session folder exists on disk before calling restartCallback
2. **whatsapp.js** (all 3 bots): Call `watchdog.detach(phoneNumber)` immediately when a session is logged out/purged
3. **commandRouter.js** (all 3 bots): Catch `rate-overlimit` errors and back off 30s instead of throwing/crashing

**Files Modified**:
- `/home/ubuntu/symmetrical-train/core/watchdog.js` — detach() method + session-exists guard
- `/home/ubuntu/symmetrical-train/core/whatsapp.js` — watchdog.detach() on logout
- `/home/ubuntu/symmetrical-train/core/commandRouter.js` — rate-overlimit backoff
- Same changes synced to `/home/ubuntu/bot/` and `/home/ubuntu/bot2/`

**Current Status**:
- Bot 8 (pappy-ultimate): Stable, restart count frozen at 116, processing commands with rate-limit backoff
- Bot 7 (pappy-ultimate-2): Stable at 6 restarts, waiting for number 234 to be re-paired via /pair in Telegram
- Number 234 needs to be re-paired — use /pair 2347086278942 in Telegram bot 7

## Latest Changes
- **Watchdog Fix**: Detach monitor on session logout, guard restart against missing sessions
- **Rate-Limit Backoff**: CommandRouter backs off 30s on rate-overlimit instead of crashing
- **All 3 bots synced**: symmetrical-train, bot, bot2 all have same fixes

## Latest Changes (2026-04-25)
- **Telegram Auto-Downloader UX Improved**: Added live in-message status updates for detected platform, fetch, download, and upload states.
- **Video to Audio Extraction**: After a video auto-download, bot now includes an inline **Extract Audio** action that downloads/sends MP3.
- **Music Finder Mode Added**: New Telegram hub toggle enables song discovery flow.
- **Text Song Search**: User sends song name, bot returns top YouTube matches as inline selection buttons.
- **Audio/Voice Assisted Flow**: Forwarded audio metadata can be used as search query; voice flow supports caption-driven search.
- **Lyrics Delivery**: After selected song download, bot attempts lyrics lookup (lyrics.ovh) and sends lyrics with the track.
- **Stability**: Fixed Telegram handler crash caused by temporal dead zone usage of `hasActiveSession` before declaration.

