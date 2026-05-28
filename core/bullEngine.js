// core/bullEngine.js
// 👑 SUPREME GOD MODE: ENCRYPTED GC STATUS PROTOCOL

const { Queue, Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateWAMessageFromContent } = require('gifted-baileys');

const stealth = require('./stealthEngine');
const logger = require('./logger');
const config = require('../config');
const { buildLinkPreview, extractUrls, fetchImageBuffer, getPreviewHint, normalizeThumbnailBuffer } = require('./linkPreview');

const nodeIdPath = path.join(__dirname, '../data/node-id.txt');
let NODE_ID;
if (fs.existsSync(nodeIdPath)) {
    NODE_ID = fs.readFileSync(nodeIdPath, 'utf8').trim();
} else {
    NODE_ID = 'NODE_' + crypto.randomBytes(3).toString('hex').toUpperCase();
    if (!fs.existsSync(path.dirname(nodeIdPath))) fs.mkdirSync(path.dirname(nodeIdPath), { recursive: true });
    fs.writeFileSync(nodeIdPath, NODE_ID);
}

const UNIQUE_QUEUE_NAME = `elite-broadcast-${NODE_ID}`;

const bullConfig = {
    connection: { host: config.redis.host, port: config.redis.port, password: config.redis.password, maxRetriesPerRequest: null }
};

const DEFAULT_JOB_OPTIONS = { attempts: 4, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 1000 };
const queueShards = new Map();
const workerShards = new Map();
const campaignTrackers = new Map();

const SHOULD_START_WORKER = process.argv.length > 1 || process.env.FORCE_BULL_WORKER === '1';

const delay = (ms) => new Promise(res => setTimeout(res, ms));
const OFFLINE_SOCKET_TTL_MS = 30 * 1000;
const OFFLINE_RETRY_HOLD_MS = 20 * 1000;
const offlineSocketCache = new Map();

const WORKER_CONCURRENCY = {
    godcast: Math.max(1, Number(process.env.BULL_CONCURRENCY_GODCAST || 1)),
    status:  Math.max(1, Number(process.env.BULL_CONCURRENCY_STATUS || 1)),
    gcast:   Math.max(1, Number(process.env.BULL_CONCURRENCY_GCAST || 2)),
    default: Math.max(1, Number(process.env.BULL_CONCURRENCY_DEFAULT || 3)),
};

const GHOST_SEND_DELAY_MS = 800;    // increased
const GHOST_DELETE_DELAY_MS = 1000;  // increased
const GHOST_RETRY_DELAY_MS = 2000;
const GHOST_PRE_STATUS_SETTLE_MS = Math.max(800, Number(process.env.BULL_GHOST_PRE_STATUS_SETTLE_MS || 1800));
const GHOST_MAX_ATTEMPTS_DEFAULT = Math.max(2, Number(process.env.BULL_GHOST_MAX_ATTEMPTS_DEFAULT || 3));
const GHOST_MAX_ATTEMPTS_LARGE_GROUP = Math.max(GHOST_MAX_ATTEMPTS_DEFAULT, Number(process.env.BULL_GHOST_MAX_ATTEMPTS_LARGE_GROUP || 6));
const GHOST_PRE_STATUS_SETTLE_LARGE_MS = Math.max(GHOST_PRE_STATUS_SETTLE_MS, Number(process.env.BULL_GHOST_PRE_STATUS_SETTLE_LARGE_MS || 2800));
const GHOST_FAIL_COOLDOWN_LARGE_MS = Math.max(1200, Number(process.env.BULL_GHOST_FAIL_COOLDOWN_LARGE_MS || 3500));
const INTER_JOB_DELAY_MS = 1500;     // delay between each group send
const MAX_STATUS_THUMB_BYTES = 45 * 1024;
const GODCAST_POST_DELAY_MS = Math.max(1500, Number(process.env.BULL_GODCAST_POST_DELAY_MS || 4500));
const STATUS_POST_DELAY_MS = Math.max(1000, Number(process.env.BULL_STATUS_POST_DELAY_MS || 2500));
const GCAST_POST_DELAY_MS = Math.max(400, Number(process.env.BULL_GCAST_POST_DELAY_MS || 900));
const POST_DELAY_JITTER_MS = Math.max(0, Number(process.env.BULL_POST_DELAY_JITTER_MS || 1000));
const FAILURE_POST_DELAY_MS = Math.max(500, Number(process.env.BULL_FAILURE_POST_DELAY_MS || 1500));
const DRAIN_DELAY_GODCAST_MS = Math.max(300, Number(process.env.BULL_DRAIN_DELAY_GODCAST_MS || 1400));
const DRAIN_DELAY_STATUS_MS = Math.max(200, Number(process.env.BULL_DRAIN_DELAY_STATUS_MS || 700));
const DRAIN_DELAY_DEFAULT_MS = Math.max(100, Number(process.env.BULL_DRAIN_DELAY_DEFAULT_MS || 400));
const SEND_RETRY_BASE_MS = Math.max(1000, Number(process.env.BULL_SEND_RETRY_BASE_MS || 6000));
const SEND_RETRY_JITTER_MS = Math.max(0, Number(process.env.BULL_SEND_RETRY_JITTER_MS || 2500));
const SEND_ATTEMPTS_STATUS = Math.max(1, Number(process.env.BULL_SEND_ATTEMPTS_STATUS || 6));
const SEND_ATTEMPTS_GODCAST = Math.max(1, Number(process.env.BULL_SEND_ATTEMPTS_GODCAST || 7));
const SEND_ATTEMPTS_GCAST = Math.max(1, Number(process.env.BULL_SEND_ATTEMPTS_GCAST || 4));
const SEND_ATTEMPTS_STATUS_FALLBACK = Math.max(1, Number(process.env.BULL_SEND_ATTEMPTS_STATUS_FALLBACK || 5));
const SEND_ATTEMPTS_LARGE_GROUP = Math.max(1, Number(process.env.BULL_SEND_ATTEMPTS_LARGE_GROUP || 15));
const LARGE_GROUP_POST_DELAY_MS = Math.max(2000, Number(process.env.BULL_POST_DELAY_LARGE_GROUP_MS || 5000));
const LARGE_GROUP_RETRY_BASE_MS = Math.max(1500, Number(process.env.BULL_RETRY_BASE_LARGE_GROUP_MS || 9000));

function isPermanentAccessError(errMsg) {
    const msg = String(errMsg || '').toLowerCase();
    return (
        msg.includes('not-authorized') ||
        msg.includes('not authorized') ||
        msg.includes('forbidden') ||
        msg.includes('403') ||
        msg.includes('not a participant') ||
        msg.includes('not participant') ||
        msg.includes('you are not a participant') ||
        msg.includes('participant not found') ||
        msg.includes('blocked') ||
        msg.includes('rejected')
    );
}

function isRetryableSendError(errMsg) {
    const msg = String(errMsg || '').toLowerCase();
    return (
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('connection') ||
        msg.includes('socket') ||
        msg.includes('stream') ||
        msg.includes('restart required') ||
        msg.includes('disconnected') ||
        msg.includes('unavailable') ||
        msg.includes('temporarily') ||
        msg.includes('rate-overlimit') ||
        msg.includes('429') ||
        msg.includes('too many') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('eai_again')
    );
}

function resolveSocketForBot(botId) {
    let sock = global.waSockByBotId?.get(String(botId || '')) || null;
    if (!sock && global.waSocks) {
        for (const [sessionKey, activeSock] of global.waSocks.entries()) {
            if (sessionKey.includes(botId)) {
                sock = activeSock;
                if (global.waSockByBotId) {
                    global.waSockByBotId.set(String(botId || ''), activeSock);
                }
                break;
            }
        }
    }
    return sock;
}

function registerCampaign(meta = {}) {
    const campaignId = String(meta.campaignId || '').trim();
    if (!campaignId) return null;
    campaignTrackers.set(campaignId, {
        campaignId,
        botId: String(meta.botId || ''),
        chat: String(meta.chat || ''),
        mode: String(meta.mode || 'broadcast'),
        total: Number(meta.total || 0),
        success: 0,
        failed: 0,
        done: false,
        failedTargets: new Set(),
        startedAt: Date.now(),
    });
    return campaignId;
}

function emitTelegramLiveLog(botId, source, line) {
    try {
        if (typeof global._pushTelegramLiveLog !== 'function') return;
        global._pushTelegramLiveLog({ botId, source, line });
    } catch {}
}

async function notifyCampaignDone(campaign) {
    if (!campaign || campaign.done) return;
    campaign.done = true;

    const sock = resolveSocketForBot(campaign.botId);
    if (!sock || !campaign.chat) {
        campaignTrackers.delete(campaign.campaignId);
        return;
    }

    const durationSec = Math.max(1, Math.round((Date.now() - campaign.startedAt) / 1000));
    const failedList = Array.from(campaign.failedTargets);
    const failedPreview = failedList.slice(0, 20).map((jid) => `• ${jid}`).join('\n');
    const failedOverflow = failedList.length > 20 ? `\n...and ${failedList.length - 20} more` : '';

    const allFailed = campaign.total > 0 && campaign.failed >= campaign.total;
    let queueCleared = false;
    if (allFailed) {
        try {
            const queue = ensureQueueForBot(campaign.botId);
            await queue.pause();
            await queue.drain();
            await queue.clean(0, 100000, 'failed');
            await queue.clean(0, 100000, 'completed');
            await queue.resume();
            queueCleared = true;
        } catch (clearErr) {
            logger.warn(`[Bull] Auto-clear failed for bot ${campaign.botId}: ${clearErr.message}`);
        }
    }

    const text = [
        '✅ *BROADCAST JOB DONE*',
        `📊 Total groups: *${campaign.total}*`,
        `✅ Successful: *${campaign.success}*`,
        `❌ Failed: *${campaign.failed}*`,
        `⏱️ Duration: *${durationSec}s*`,
        allFailed
            ? (queueCleared
                ? '\n🧹 Redis queue looked choked, auto-cleared for this bot shard. Please resend your command.'
                : '\n⚠️ All jobs failed. Queue clear attempt failed, please retry command.')
            : '',
        campaign.failed > 0
            ? `\n*Failed groups:*\n${failedPreview}${failedOverflow}`
            : '\nAll groups posted successfully.'
    ].join('\n');

    await sock.sendMessage(campaign.chat, { text }).catch(() => {});
    emitTelegramLiveLog(campaign.botId, 'BROADCAST', `Campaign done (${campaign.mode}): total=${campaign.total}, ok=${campaign.success}, failed=${campaign.failed}`);
    campaignTrackers.delete(campaign.campaignId);
}

async function settleCampaignFromJob(job, isSuccess) {
    const campaignId = String(job?.data?.campaignId || '').trim();
    if (!campaignId || !campaignTrackers.has(campaignId)) return;

    const campaign = campaignTrackers.get(campaignId);
    if (campaign.done) return;

    if (isSuccess) {
        campaign.success += 1;
        emitTelegramLiveLog(campaign.botId, 'BROADCAST', `Progress ${campaign.mode}: ${campaign.success + campaign.failed}/${campaign.total} • ✅ ${String(job?.data?.targetJid || '').split('@')[0]}`);
    } else {
        campaign.failed += 1;
        const target = String(job?.data?.targetJid || '').trim();
        if (target) campaign.failedTargets.add(target);
        emitTelegramLiveLog(campaign.botId, 'BROADCAST', `Progress ${campaign.mode}: ${campaign.success + campaign.failed}/${campaign.total} • ❌ ${target || 'unknown'}`);
    }

    const processed = campaign.success + campaign.failed;
    if (campaign.total > 0 && processed >= campaign.total) {
        await notifyCampaignDone(campaign);
    }
}

const withTimeout = (promise, ms = 15000) => {
    return Promise.race([ promise, new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp Server Timeout')), ms)) ]);
};

function normalizeStatusBackgroundColor(input) {
    if (Number.isFinite(input)) return input;

    const raw = String(input || '#FFB7C5').trim();
    const hex = raw.replace('#', '').toLowerCase();
    if (!/^[0-9a-f]{6,8}$/.test(hex)) return -4737091; // ffb7c5 as signed int32

    const argbHex = hex.length === 6 ? `ff${hex}` : hex;
    const parsed = Number.parseInt(argbHex, 16);
    if (!Number.isFinite(parsed)) return -4737091;

    return parsed > 0x7fffffff ? parsed - 0x100000000 : parsed;
}

function reviveBuffers(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    if (Array.isArray(value)) return value.map(reviveBuffers);

    const revived = {};
    for (const [key, child] of Object.entries(value)) revived[key] = reviveBuffers(child);
    return revived;
}

async function relayExactMessage(sock, targetJid, sourceMessage) {
    const revivedMessage = reviveBuffers(sourceMessage);
    const fullMsg = generateWAMessageFromContent(targetJid, revivedMessage, {
        userJid: sock.user.id,
    });

    await withTimeout(sock.relayMessage(targetJid, fullMsg.message, {
        messageId: fullMsg.key.id,
    }), 25000);
}

function extractWhatsAppInviteCode(text) {
    const match = String(text || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    return match ? match[1] : null;
}

async function buildStatusPayloadFromSourceMessage(sourceMessage, sourceContextInfo, fallbackText, font, backgroundColor) {
    const revived = reviveBuffers(sourceMessage);
    const revivedContext = reviveBuffers(sourceContextInfo || {});
    if ((!revived || typeof revived !== 'object') && (!revivedContext || typeof revivedContext !== 'object')) return null;

    if (revived?.groupStatusMessage) return { groupStatusMessage: revived.groupStatusMessage };
    if (revived?.groupInviteMessage) return { groupStatusMessage: { message: { groupInviteMessage: revived.groupInviteMessage } } };

    const statusFont = font !== undefined ? font : 3;
    const statusBg   = normalizeStatusBackgroundColor(backgroundColor);
    // Use fallbackText (aesthetic-wrapped text from godcast) as display text if provided
    // Fall back to the original extendedTextMessage text only if no fallback given
    const extText = fallbackText || revived?.extendedTextMessage?.text || revived?.conversation || '';    // EXACT RELAY: pass extendedTextMessage through groupStatusMessage.message like .tag
    // so WA can render the native card from the original message payload.
    if (revived?.extendedTextMessage) {
        const ext = revived.extendedTextMessage;
        return {
            groupStatusMessage: {
                message: {
                    extendedTextMessage: {
                        ...ext,
                        text: extText || ext.text || '',
                    }
                }
            }
        };
    }

    // Plain text with no URL
    const urls = extractUrls(extText);
    if (!urls.length) {
        return { groupStatusMessage: { text: extText, font: statusFont, backgroundColor: statusBg } };
    }

    // Has URL but no extendedTextMessage — build preview fresh
    const targetUrl = urls[0];
    let title = '', description = '', thumb = null;
    try {
        const preview = await buildLinkPreview(extText, true);
        if (preview?.title)       title       = preview.title;
        if (preview?.description) description = preview.description;
        if (preview?.thumbnail)   thumb       = await normalizeThumbnailBuffer(preview.thumbnail);
        if (!thumb && preview?.thumbnailUrl) {
            const fetched = await fetchImageBuffer(preview.thumbnailUrl).catch(() => null);
            if (fetched) thumb = await normalizeThumbnailBuffer(fetched);
        }
    } catch {}

    return {
        groupStatusMessage: {
            message: {
                extendedTextMessage: {
                    text: extText,
                    matchedText: targetUrl,
                    canonicalUrl: targetUrl,
                    title,
                    description,
                    previewType: 0,
                    ...(thumb ? { jpegThumbnail: thumb } : {}),
                }
            }
        }
    };
}

function buildChatLinkPayload(text, ext, sourceContextInfo) {
    const targetUrl = ext.matchedText || ext.canonicalUrl || ext['matched-text'] || '';
    if (!targetUrl) return { text };
    return {
        text,
        contextInfo: {
            matchedText:    targetUrl,
            canonicalUrl:   targetUrl,
            'matched-text': targetUrl,
            externalAdReply: sourceContextInfo?.externalAdReply || {
                title:                 ext.title || '',
                body:                  ext.description || '',
                mediaType:             1,
                sourceUrl:             targetUrl,
                renderLargerThumbnail: true,
                showAdAttribution:     false,
                ...(ext.thumbnailUrl ? { thumbnailUrl: ext.thumbnailUrl } : {}),
                ...(Buffer.isBuffer(ext.jpegThumbnail) ? { jpegThumbnail: ext.jpegThumbnail } : {}),
            },
        },
    };
}


function normalizeBotId(botId) {
    const raw = String(botId || 'global').trim();
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_') || 'global';
}

function getQueueNameForBot(botId) {
    return `${UNIQUE_QUEUE_NAME}-${normalizeBotId(botId)}`;
}

// Each command type gets its own queue shard so godcast never blocks status cmds
const QUEUE_TYPE_MAP = {
    godcast:        'godcast',
    gcast:          'gcast',
    advanced_status:'status',
    updategstatus:  'status',
    ggstatus:       'status',
    gstatus:        'status',
    setnewgcstatus: 'status',
    groupstatus:    'status',
};

function getQueueShardForJob(data) {
    const botShard = normalizeBotId(data?.botId);
    const cmdType  = String(data?.commandType || data?.mode || 'default').toLowerCase();
    const typeShard = QUEUE_TYPE_MAP[cmdType] || 'default';
    return `${UNIQUE_QUEUE_NAME}-${botShard}-${typeShard}`;
}

function ensureQueueForBot(botId) {
    const queueName = getQueueNameForBot(botId);
    if (!queueShards.has(queueName)) {
        const queue = new Queue(queueName, { ...bullConfig, defaultJobOptions: DEFAULT_JOB_OPTIONS });
        queueShards.set(queueName, queue);
    }
    return queueShards.get(queueName);
}

function ensureQueueForShard(shardName) {
    if (!queueShards.has(shardName)) {
        const queue = new Queue(shardName, { ...bullConfig, defaultJobOptions: DEFAULT_JOB_OPTIONS });
        queueShards.set(shardName, queue);
    }
    return queueShards.get(shardName);
}

function getQueueFromJobData(data) {
    const shardName = getQueueShardForJob(data);
    return ensureQueueForShard(shardName);
}

async function processBroadcastJob(job) {
    const { botId, targetJid, textContent, mode, useGhostProtocol, font, backgroundColor, mediaPath, isVideo, sourceMessage, sourceContextInfo, commandType, groupSize } = job.data;
    // Keep socket activity alive during broadcast so heartbeat doesn't kill the socket
    if (botId && global._lastEventActivity) {
        global._lastEventActivity.set(
            [...(global.activeSockets?.keys() || [])].find(k => k.includes(botId)) || botId,
            Date.now()
        );
    }
    const executeJob = async () => {
        const jobStartedAt = Date.now();
        let ghostDurationMs = 0;
        let previewDurationMs = 0;
        let sendDurationMs = 0;
        let usedLinkPreview = false;
        const largeGroupThreshold = Math.max(50, Number(process.env.GODCAST_LARGE_GROUP_THRESHOLD || 200));
        const isLargeGroup = Number(groupSize || 0) >= largeGroupThreshold;
        const largeGroupSendTimeoutMs = Math.max(25000, Number(process.env.BULL_SEND_TIMEOUT_LARGE_GROUP_MS || 40000));
        const sendTimeoutMs = isLargeGroup ? largeGroupSendTimeoutMs : 25000;

        const offlineTs = offlineSocketCache.get(botId);
        if (offlineTs && Date.now() - offlineTs < OFFLINE_SOCKET_TTL_MS) {
            // Keep retry attempts alive long enough for WA reconnect cycles.
            await delay(OFFLINE_RETRY_HOLD_MS);
            throw new Error(`Socket offline for bot: ${botId} (cached)`);
        }

        let sock = resolveSocketForBot(botId);
        if (!sock) {
            offlineSocketCache.set(botId, Date.now());
            // Prevent immediate retry bursts while the socket is still reconnecting.
            await delay(OFFLINE_RETRY_HOLD_MS);
            throw new Error(`Socket offline for bot: ${botId}`);
        }
        offlineSocketCache.delete(botId);

        // ─── 1. 👻 GHOST PROTOCOL ─────────────────
        if (useGhostProtocol) {
            const ghostStartedAt = Date.now();
            let ghostInjected = false;
            let ghostDeleted = false;
            let retries = 0;
            const maxRetries = isLargeGroup ? GHOST_MAX_ATTEMPTS_LARGE_GROUP : GHOST_MAX_ATTEMPTS_DEFAULT;

            // Use random single emoji instead of invisible chars — less detectable
            const GHOST_CHARS = ['​', '⁠', '⁡', '⁢', '⁣'];
            const ghostText = GHOST_CHARS[Math.floor(Math.random() * GHOST_CHARS.length)];

            while (!ghostInjected && retries < maxRetries) {
                try {
                    const ghost = await withTimeout(sock.sendMessage(targetJid, { text: ghostText }), 15000);
                    if (!ghost?.key) throw new Error('Ghost message key not received');
                    // Random human-like delay before delete; longer for large groups.
                    const preDeleteDelay = isLargeGroup
                        ? (900 + Math.floor(Math.random() * 1400))
                        : (500 + Math.floor(Math.random() * 1000));
                    await delay(preDeleteDelay);
                    ghostInjected = true;

                    try {
                        await withTimeout(sock.sendMessage(targetJid, { delete: ghost.key }), 15000);
                        // Random settle delay; longer for large groups.
                        const postDeleteDelay = isLargeGroup
                            ? (700 + Math.floor(Math.random() * 900))
                            : (300 + Math.floor(Math.random() * 500));
                        await delay(postDeleteDelay);
                        ghostDeleted = true;
                    } catch (deleteErr) {
                        logger.warn(`👻 Ghost delete failed for ${targetJid}, posting status anyway: ${deleteErr.message}`);
                    }
                } catch (ghostErr) {
                    retries++;
                    logger.warn(`👻 Ghost send attempt ${retries}/${maxRetries} failed for ${targetJid}: ${ghostErr.message}`);
                    if (retries < maxRetries) await delay(GHOST_RETRY_DELAY_MS);
                }
            }

            ghostDurationMs = Date.now() - ghostStartedAt;
            if (ghostInjected) {
                logger.info(`👻 Ghost protocol ${ghostDeleted ? 'succeeded' : 'partial'} for ${targetJid}`);
                const baseSettleMs = isLargeGroup ? GHOST_PRE_STATUS_SETTLE_LARGE_MS : GHOST_PRE_STATUS_SETTLE_MS;
                await delay(ghostDeleted ? baseSettleMs : Math.floor(baseSettleMs / 2));
            } else {
                logger.warn(`👻 Ghost send failed after ${maxRetries} attempts for ${targetJid}, posting status directly`);
                // For large-group godcast, add a cooldown before status send to avoid immediate churn.
                if (isLargeGroup && useGhostProtocol) {
                    await delay(GHOST_FAIL_COOLDOWN_LARGE_MS);
                }
            }
        }

        const sourceText = String(textContent || '');
        const hasUrlInSource = extractUrls(sourceText).length > 0;
        const shouldKeepRawText = mode === 'advanced_status' || hasUrlInSource;
        const mutatedText = shouldKeepRawText
            ? sourceText
            : (stealth.mutateMessage ? stealth.mutateMessage(sourceText) : sourceText);
        const statusBg = normalizeStatusBackgroundColor(backgroundColor);

        try {
        let payload = {};

        // ─── 3. MEDIA HANDLING ────────────────────
        if (mediaPath && fs.existsSync(mediaPath)) {
            const mediaBuffer = fs.readFileSync(mediaPath);
            if (mode === 'advanced_status') {
                // Group status media — must use groupStatusMessage format to post to status not chat
                payload = isVideo
                    ? { groupStatusMessage: { video: mediaBuffer, caption: mutatedText } }
                    : { groupStatusMessage: { image: mediaBuffer, caption: mutatedText } };
            } else {
                payload = isVideo ? { video: mediaBuffer, caption: mutatedText } : { image: mediaBuffer, caption: mutatedText };
            }
        }
        
        // ─── 4. GC STATUS (.godcast & .updategstatus) ───
        else if (mode === 'advanced_status') {
            if (sourceMessage || sourceContextInfo) {
                const sourcedPayload = await buildStatusPayloadFromSourceMessage(sourceMessage, sourceContextInfo, mutatedText, font, backgroundColor);
                if (sourcedPayload) {
                    payload = sourcedPayload;
                    const ext = payload?.groupStatusMessage?.message?.extendedTextMessage;
                    if (ext?.matchedText || ext?.canonicalUrl || ext?.title || ext?.jpegThumbnail) {
                        usedLinkPreview = true;
                    }
                } else {
                    payload = {
                        groupStatusMessage: {
                            text: mutatedText,
                            font: font !== undefined ? font : 3,
                            backgroundColor: statusBg
                        }
                    };
                }
            } else {
                    const urls = extractUrls(mutatedText);
                if (urls.length > 0) {
                    // Build preview ourselves — gifted-baileys' getUrlInfo gets rate-limited on
                    // chat.whatsapp.com links. We inject a pre-built extendedTextMessage with
                    // contextInfo so gcstatus.js takes the storyData.message path and skips
                    // its own getUrlInfo call entirely.
                    usedLinkPreview = true;
                    const statusFont = font !== undefined ? font : 3;
                    const statusBg = normalizeStatusBackgroundColor(backgroundColor);
                    const targetUrl = urls[0];

                    let previewTitle = '';
                    let previewDescription = '';
                    let previewThumb = null;

                    // For WhatsApp invite links, enrich with live group metadata
                    const inviteCode = extractWhatsAppInviteCode(mutatedText);
                    if (inviteCode) {
                        try {
                            const inviteInfo = await withTimeout(sock.groupGetInviteInfo(inviteCode), 9000);
                            previewTitle = inviteInfo?.subject || '';
                            previewDescription = `${inviteInfo?.size || ''} participants`.trim();
                            if (inviteInfo?.id) {
                                try {
                                    const ppUrl = await withTimeout(sock.profilePictureUrl(inviteInfo.id, 'image'), 5000);
                                    if (ppUrl) {
                                        const thumb = await fetchImageBuffer(ppUrl).catch(() => null);
                                        const normalizedInviteThumb = await normalizeThumbnailBuffer(thumb);
                                        if (normalizedInviteThumb && normalizedInviteThumb.length <= MAX_STATUS_THUMB_BYTES) {
                                            previewThumb = normalizedInviteThumb;
                                        }
                                    }
                                } catch {}
                            }
                        } catch (inviteErr) {
                            logger.warn(`⚠️ Could not fetch invite info for status preview: ${inviteErr.message}`);
                        }
                    }

                    try {
                        const previewStartedAt = Date.now();
                        const preview = await withTimeout(
                            buildLinkPreview(mutatedText, true, { resolveBudgetMs: 12000, imageBudgetMs: 9000 }),
                            13000
                        );
                        previewDurationMs = Date.now() - previewStartedAt;
                        if (preview?.title) previewTitle = preview.title;
                        if (preview?.description) previewDescription = preview.description;
                        if (!previewThumb || previewThumb.length > MAX_STATUS_THUMB_BYTES) {
                            const normalized = await normalizeThumbnailBuffer(preview?.thumbnail || null);
                            if (normalized && normalized.length <= MAX_STATUS_THUMB_BYTES) {
                                previewThumb = normalized;
                            }
                        }
                    } catch {}

                    // Build as extendedTextMessage payload, same rendering family as .tag relay.
                    payload = {
                        groupStatusMessage: {
                            message: {
                                extendedTextMessage: {
                                    text: mutatedText,
                                    matchedText: targetUrl,
                                    canonicalUrl: targetUrl,
                                    title: previewTitle,
                                    description: previewDescription,
                                    previewType: 0,
                                    ...(previewThumb ? { jpegThumbnail: previewThumb } : {}),
                                }
                            }
                        }
                    };
                } else {
                    payload = {
                        groupStatusMessage: {
                            text: mutatedText,
                            font: font !== undefined ? font : 3,
                            backgroundColor: statusBg
                        }
                    };
                }
            }
        } 
        
        // ─── 5. NORMAL CHAT BROADCAST (.gcast) ────
        else {
            if (sourceMessage) {
                // extendedTextMessage with a URL — rebuild preview with embedded buffer
                if (sourceMessage.extendedTextMessage) {
                    const ext = sourceMessage.extendedTextMessage;
                    const extText = ext.text || mutatedText || '';
                    payload = buildChatLinkPayload(extText, ext, sourceContextInfo);
                    if (payload.contextInfo) usedLinkPreview = true;
                    else {
                        // No URL — fallback to fresh build
                        const urls = extractUrls(extText);
                        if (urls.length) {
                            let preview = null;
                            try { preview = await buildLinkPreview(extText, false); } catch {}
                            if (preview?.externalAdReply) { payload.contextInfo = preview; usedLinkPreview = true; }
                        }
                    }
                } else {
                    await relayExactMessage(sock, targetJid, sourceMessage);
                    if (mediaPath && fs.existsSync(mediaPath)) { try { fs.unlinkSync(mediaPath); } catch {} }
                    logger.success(`🚀 Delivered cloned message to: ${targetJid}`);
                    return { targetJid };
                }
            } else {
            const inviteCode = extractWhatsAppInviteCode(mutatedText);
            if (inviteCode) {
                // Prefer rich ad-reply card for invite links so users get the clickable preview button.
                let invitePreview = null;
                try { invitePreview = await buildLinkPreview(mutatedText, false); } catch {}

                payload = { text: mutatedText };
                if (invitePreview?.externalAdReply) {
                    invitePreview.externalAdReply.renderLargerThumbnail = true;
                    payload.contextInfo = invitePreview;
                    usedLinkPreview = true;
                } else {
                    try {
                        const inviteInfo = await sock.groupGetInviteInfo(inviteCode);
                        payload = {
                            groupInvite: {
                                jid: inviteInfo.id,
                                inviteCode,
                                inviteExpiration: 0,
                                subject: inviteInfo.subject || 'WhatsApp Group',
                                text: mutatedText,
                            }
                        };
                    } catch (inviteError) {
                        logger.warn(`⚠️ Invite metadata lookup failed for ${targetJid}: ${inviteError.message}`);
                        payload = { text: mutatedText };
                    }
                }
            } else {
                const urls2 = extractUrls(mutatedText);
                if (urls2.length > 0) {
                    let lp = null;
                    try { lp = await buildLinkPreview(mutatedText, false); } catch {}
                    payload = { text: mutatedText };
                    if (lp?.externalAdReply) {
                        lp.externalAdReply.renderLargerThumbnail = true;
                        payload.contextInfo = lp;
                        usedLinkPreview = true;
                    }
                } else {
                    payload = { text: mutatedText };
                }
            }
            }

        }

        // ─── 6. ENCRYPTED DELIVERY ────────────────
        // By using standard sendMessage, Baileys perfectly encrypts the GC Status so it NEVER turns invisible!
        const sendStartedAt = Date.now();
        const sendPayloadWithRetry = async (payloadToSend, maxAttempts, stage) => {
            let lastErr = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    await withTimeout(sock.sendMessage(targetJid, payloadToSend), sendTimeoutMs);
                    return;
                } catch (err) {
                    lastErr = err;
                    const errMsg = String(err.message || err).toLowerCase();
                    if (isPermanentAccessError(errMsg)) throw err;
                    if (!isRetryableSendError(errMsg) || attempt >= maxAttempts) throw err;

                    const retryBase = isLargeGroup ? LARGE_GROUP_RETRY_BASE_MS : SEND_RETRY_BASE_MS;
                    const waitMs = (retryBase * attempt) + Math.floor(Math.random() * (SEND_RETRY_JITTER_MS + 1));
                    logger.warn(`[QueueRetry] ${stage} retry ${attempt}/${maxAttempts} for ${targetJid} in ${waitMs}ms: ${err.message}`);
                    await delay(waitMs);
                    sock = resolveSocketForBot(botId) || sock;
                }
            }
            throw lastErr || new Error('send failed');
        };

        try {
            const largeGroupAttempts = Math.max(
                useGhostProtocol ? SEND_ATTEMPTS_GODCAST : SEND_ATTEMPTS_STATUS,
                SEND_ATTEMPTS_LARGE_GROUP
            );
            const primaryAttempts = mode === 'advanced_status'
                ? (isLargeGroup ? largeGroupAttempts : (useGhostProtocol ? SEND_ATTEMPTS_GODCAST : SEND_ATTEMPTS_STATUS))
                : SEND_ATTEMPTS_GCAST;
            await sendPayloadWithRetry(payload, primaryAttempts, 'primary');
        } catch (primarySendErr) {
            // Safety fallback: never leave advanced_status as ghost-only.
            if (mode === 'advanced_status') {
                logger.warn(`⚠️ Advanced status rich payload failed for ${targetJid}, retrying safe payload: ${primarySendErr.message}`);
                const fallbackPayload = {
                    groupStatusMessage: {
                        text: mutatedText,
                        font: font !== undefined ? font : 3,
                        backgroundColor: statusBg
                    }
                };
                const fallbackAttempts = isLargeGroup
                    ? Math.max(SEND_ATTEMPTS_STATUS_FALLBACK, SEND_ATTEMPTS_LARGE_GROUP)
                    : SEND_ATTEMPTS_STATUS_FALLBACK;
                await sendPayloadWithRetry(fallbackPayload, fallbackAttempts, 'status-fallback');
                usedLinkPreview = false;
            } else {
                throw primarySendErr;
            }
        }
        sendDurationMs = Date.now() - sendStartedAt;

        if (mediaPath && fs.existsSync(mediaPath)) { try { fs.unlinkSync(mediaPath); } catch {} }

        logger.success(`🚀 Delivered ${mode === 'advanced_status' ? 'GC Status' : 'Message'} to: ${targetJid}`);
        logger.info(`[QueueMetrics] job=${job.id || 'n/a'} mode=${mode} target=${targetJid} totalMs=${Date.now() - jobStartedAt} ghostMs=${ghostDurationMs} previewMs=${previewDurationMs} sendMs=${sendDurationMs} usedPreview=${usedLinkPreview}`);
        
        // Post-send delay — godcast gets more breathing room to avoid socket saturation on big accounts
        const basePostDelay = useGhostProtocol
            ? GODCAST_POST_DELAY_MS
            : (mode === 'advanced_status' ? STATUS_POST_DELAY_MS : GCAST_POST_DELAY_MS);
        const selectedPostDelay = isLargeGroup ? Math.max(basePostDelay, LARGE_GROUP_POST_DELAY_MS) : basePostDelay;
        const postDelay = selectedPostDelay + Math.floor(Math.random() * (POST_DELAY_JITTER_MS + 1));
        await delay(postDelay);
        return { targetJid };

        } catch (deliveryError) {
        const postDelay = FAILURE_POST_DELAY_MS + Math.floor(Math.random() * (POST_DELAY_JITTER_MS + 1));
        await delay(postDelay);
        const errMsg = String(deliveryError.message || deliveryError).toLowerCase();
        
        // Log the specific error for debugging
        if (errMsg.includes('ghost protocol')) {
            logger.error(`❌ Ghost Protocol Failed for ${targetJid}: ${deliveryError.message}`);
        } else if (isPermanentAccessError(errMsg)) {
            logger.warn(`⚠️ Permanent access failure for ${targetJid}: ${deliveryError.message}`);
            if (typeof job.discard === 'function') job.discard();
        } else {
            logger.error(`❌ Delivery failed for ${targetJid}: ${deliveryError.message}`);
        }
        logger.warn(`[QueueMetrics] FAILED job=${job.id || 'n/a'} mode=${mode} target=${targetJid} totalMs=${Date.now() - jobStartedAt} ghostMs=${ghostDurationMs} previewMs=${previewDurationMs} sendMs=${sendDurationMs} usedPreview=${usedLinkPreview}`);
        
            throw deliveryError;
        }
    };

    // Feature queues and worker concurrency already isolate load per bot+command type.
    // Do not add a global lane lock here; it serializes users unnecessarily.
    return executeJob();
}

function ensureWorkerForQueue(queueName) {
    if (!SHOULD_START_WORKER) return null;
    if (!workerShards.has(queueName)) {
        // Dedicated per-feature processors: no single shared worker lane.
        let concurrency = WORKER_CONCURRENCY.default;
        if (queueName.includes('-godcast')) concurrency = 1;
        else if (queueName.includes('-status')) concurrency = 1;
        else if (queueName.includes('-gcast')) concurrency = WORKER_CONCURRENCY.gcast;

        const worker = new Worker(queueName, processBroadcastJob, {
            ...bullConfig,
            concurrency,
            lockDuration: 300000,
            stalledInterval: 60000,
            maxStalledCount: 3,
            drainDelay: queueName.includes('-godcast')
                ? DRAIN_DELAY_GODCAST_MS
                : (queueName.includes('-status') ? DRAIN_DELAY_STATUS_MS : DRAIN_DELAY_DEFAULT_MS),
        });
        worker.on('error', (err) => {
            logger.error(`[Bull] Worker error on ${queueName}: ${err.message}`);
        });
        worker.on('completed', (job) => {
            settleCampaignFromJob(job, true).catch(() => {});
        });
        worker.on('failed', (job) => {
            const attempts = Number(job?.opts?.attempts || DEFAULT_JOB_OPTIONS.attempts || 1);
            const attemptsMade = Number(job?.attemptsMade || 0);
            const isTerminal = attemptsMade >= attempts;
            if (isTerminal) {
                settleCampaignFromJob(job, false).catch(() => {});
            }
        });
        workerShards.set(queueName, worker);
        logger.info(`[Bull] Worker attached to queue shard ${queueName}`);
    }
    return workerShards.get(queueName);
}

function ensureWorkerForJobData(data) {
    const queue = getQueueFromJobData(data);
    ensureWorkerForQueue(queue.name);
    return queue;
}

const broadcastQueue = {
    async add(name, data, opts) {
        const queue = ensureWorkerForJobData(data);
        return queue.add(name, data, opts);
    },

    async addBulk(jobs) {
        if (!Array.isArray(jobs) || jobs.length === 0) return [];

        const grouped = new Map();
        for (const job of jobs) {
            const queue = ensureWorkerForJobData(job?.data || {});
            const key = queue.name;
            if (!grouped.has(key)) grouped.set(key, { queue, jobs: [] });
            grouped.get(key).jobs.push(job);
        }

        const out = [];
        for (const { queue, jobs: batch } of grouped.values()) {
            const added = await queue.addBulk(batch);
            out.push(...added);
        }
        return out;
    },

    async pause() {
        if (!queueShards.size) ensureQueueForBot('global');
        await Promise.all(Array.from(queueShards.values()).map((q) => q.pause()));
    },

    async resume() {
        if (!queueShards.size) ensureQueueForBot('global');
        await Promise.all(Array.from(queueShards.values()).map((q) => q.resume()));
    },

    async drain() {
        if (!queueShards.size) ensureQueueForBot('global');
        await Promise.all(Array.from(queueShards.values()).map((q) => q.drain()));
    },

    async obliterate(opts) {
        if (!queueShards.size) ensureQueueForBot('global');
        await Promise.all(Array.from(queueShards.values()).map((q) => q.obliterate(opts)));
    },

    async getJobCounts(...types) {
        if (!queueShards.size) ensureQueueForBot('global');
        const totals = {};
        const counts = await Promise.all(Array.from(queueShards.values()).map((q) => q.getJobCounts(...types)));
        for (const c of counts) {
            for (const [k, v] of Object.entries(c || {})) {
                totals[k] = (totals[k] || 0) + Number(v || 0);
            }
        }
        return totals;
    }
};

async function wipeQueue() {
    try {
        await broadcastQueue.pause();
        await broadcastQueue.drain();
        await broadcastQueue.obliterate({ force: true });
        await broadcastQueue.resume();
        return true;
    } catch { return false; }
}

async function getQueueDebugSnapshot() {
    const shardEntries = Array.from(queueShards.entries());
    const shards = await Promise.all(shardEntries.map(async ([queueName, queue]) => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        return {
            queueName,
            workerAttached: workerShards.has(queueName),
            counts,
        };
    }));

    return {
        nodeId: NODE_ID,
        shardCount: shards.length,
        shards,
    };
}

module.exports = { broadcastQueue, wipeQueue, getQueueDebugSnapshot, registerCampaign };
