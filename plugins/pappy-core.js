'use strict';
// plugins/pappy-core.js

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { downloadMediaMessage } = require('gifted-baileys');
const { generateMenu } = require('../modules/menuEngine');
const menuSongManager = require('../modules/menuSongManager');
const logger = require('../core/logger');
const { createContextInfo } = require('../core/linkPreview');

const bindDbPath = path.join(__dirname, '../data/stickerCmds.json');
let stickerDbCache = null;

async function initStickerDb() {
    try {
        await fs.promises.mkdir(path.join(__dirname, '../data'), { recursive: true });
        stickerDbCache = fs.existsSync(bindDbPath)
            ? JSON.parse(await fs.promises.readFile(bindDbPath, 'utf-8'))
            : {};
    } catch { stickerDbCache = {}; }
}
initStickerDb();

async function saveStickerDb() {
    try { await fs.promises.writeFile(bindDbPath, JSON.stringify(stickerDbCache, null, 2)); } catch {}
}

// Pollinations — no API key, totally free, returns image buffer
const POLLINATIONS_PROMPTS = [
    // Anime characters
    'epic anime male protagonist with glowing aura, silver hair, dark fantasy armor, cinematic lighting, ultra detailed, 4k anime art style',
    'beautiful anime waifu with long flowing hair, cherry blossom background, soft pastel colors, studio ghibli inspired, dreamy atmosphere',
    'powerful anime girl warrior, katana, red and black outfit, dynamic action pose, neon city background, cyberpunk anime style',
    'cool anime boy with hoodie, aesthetic lo-fi vibes, city rooftop at night, moonlight, chill genz anime art',
    'anime isekai hero summoned to fantasy world, glowing portal, dramatic lighting, full armor, epic fantasy anime scene',
    // Tom and Jerry / cartoon crossover
    'Tom and Jerry in anime isekai style, fantasy world, Tom as a samurai cat, Jerry as a ninja mouse, epic battle scene, anime art',
    'Tom and Jerry genz aesthetic, streetwear outfits, sneakers, urban background, cool cartoon crossover art, vibrant colors',
    // Waifu
    'stunning anime waifu in traditional japanese kimono, sakura petals falling, golden hour lighting, ultra detailed anime illustration',
    'cute anime girl with cat ears, oversized hoodie, cozy room aesthetic, soft lighting, genz vibe, high quality anime art',
    'anime waifu with heterochromia eyes, magical girl transformation, sparkles and stars, pastel fantasy background',
    // Cool genz
    'aesthetic anime cityscape at night, neon lights reflection on rain, lone figure with umbrella, lofi anime art style',
    'anime characters playing basketball in futuristic city, slam dunk moment, dynamic motion blur, vibrant street art style',
    'genz anime squad, diverse characters, matching drip outfits, graffiti wall background, cool urban anime illustration',
    'anime boy with headphones, music visualizer aura, floating in space, stars and galaxies, dreamy aesthetic',
    'dragon ball style power up scene, golden aura explosion, anime male character, ultra instinct eyes, epic cinematic',
    // Isekai
    'isekai anime scene, overpowered hero standing on mountain of defeated enemies, dramatic sky, epic fantasy art',
    'anime girl reincarnated as a slime, cute monster companions, colorful fantasy world, isekai adventure art',
    'dark isekai anime, demon lord throne room, powerful villain aesthetic, gothic fantasy, ultra detailed anime art',
];

async function getPollinationsImage() {
    const prompt = POLLINATIONS_PROMPTS[Math.floor(Math.random() * POLLINATIONS_PROMPTS.length)];
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=800&height=600&nologo=true&model=flux&seed=${Math.floor(Math.random() * 99999)}`;
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
        return Buffer.from(res.data);
    } catch {
        return null;
    }
}

function getQuotedMessage(msg) {
    return msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

function detectMediaType(message) {
    if (!message) return null;
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.documentMessage) return 'document';
    return null;
}

function makeUploadName(message, mediaType) {
    if (mediaType === 'document') {
        const name = message.documentMessage?.fileName;
        if (name && name.trim()) return name;
        return 'file.bin';
    }
    if (mediaType === 'image') return 'image.jpg';
    if (mediaType === 'video') return 'video.mp4';
    return 'file.bin';
}

async function uploadBufferToUrl(buffer, fileName) {
    const mimeType = fileName.endsWith('.mp4')
        ? 'video/mp4'
        : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
            ? 'image/jpeg'
            : 'application/octet-stream';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), fileName);

    // Primary: tmpfiles.org (stable JSON API)
    try {
        const res = await axios.post('https://tmpfiles.org/api/v1/upload', form, { timeout: 20000 });
        const pageUrl = res?.data?.data?.url;
        if (pageUrl && pageUrl.includes('tmpfiles.org/')) {
            return pageUrl.replace(/^http:\/\//i, 'https://');
        }
    } catch {}

    // Fallback: 0x0.st returns direct URL in plain text
    const altForm = new FormData();
    altForm.append('file', new Blob([buffer], { type: mimeType }), fileName);
    const alt = await axios.post('https://0x0.st', altForm, {
        timeout: 20000,
        responseType: 'text',
        transformResponse: [(v) => v],
    });

    const url = String(alt.data || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Upload provider did not return a URL');
    return url.replace(/^http:\/\//i, 'https://');
}

// Public menu — useful commands visible to everyone
function isGlobalOwnerFromConfig(jid) {
    const { ownerWhatsAppJids } = require('../config');
    const ownerSet = new Set((ownerWhatsAppJids || []).map(j => String(j || '').trim()).filter(Boolean));
    const ownerDigits = new Set(Array.from(ownerSet).map(j => String(j || '').replace(/[^0-9]/g, '')).filter(Boolean));
    const norm = String(jid || '').replace(/:\d+(?=@)/g, '').trim();
    const digits = norm.replace(/[^0-9]/g, '');
    return ownerSet.has(jid) || ownerSet.has(norm) || ownerDigits.has(digits);
}

module.exports = {
    category: 'SYSTEM',
    commands: [
        { cmd: '.menu',    role: 'public' },
        { cmd: '.ping',    role: 'public' },
        { cmd: '.sys',     role: 'public' },
        { cmd: '.pappy',   role: 'owner'  },
        { cmd: '.papoy',   role: 'owner'  },

        { cmd: '.tts',     role: 'public' },
        { cmd: '.video',   role: 'public' },
        { cmd: '.song',    role: 'public' },
        { cmd: '.tourl',   role: 'public' },
        { cmd: '.imgurl',  role: 'public' },
        { cmd: '.videourl', role: 'public' },
        { cmd: '.fileurl', role: 'public' },
        { cmd: '.owner',   role: 'public' },
        { cmd: '.queues',  role: 'owner'  },
        { cmd: '.sudo',    role: 'owner'  },
        { cmd: '.delsudo', role: 'owner'  },
        { cmd: '.bind',    role: 'owner'  },
        { cmd: '.setprefix', role: 'owner'  },
        { cmd: '.prefix', role: 'public'  },
        { cmd: '.nodemode', role: 'owner'  },
    ],

    execute: async ({ sock, msg, args, text, user, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();
        const sender = msg.key.participant || msg.key.remoteJid;

        if (cmd === '.ping') {
            const moment = require('moment-timezone');

            // Latency
            const msgTs = (Number(msg.messageTimestamp) || 0) * 1000;
            const sendStart = Date.now();
            await sock.sendMessage(jid, { react: { text: '🏓', key: msg.key } });
            const latency = msgTs ? Date.now() - msgTs : Date.now() - sendStart;

            // Timezone & time
            const userTz = 'Africa/Lagos';
            const now = moment().tz(userTz);
            const hour = now.hour();
            const isDay = hour >= 6 && hour < 18;

            // Mood based on latency
            let mood = '🟢 Smooth';
            let vibe = 'systems clean';
            let note = 'no stress, just vibes.';
            let color = '🟢';
            if (latency > 150) { mood = '🟡 Delay';     vibe = 'adjusting flow';    note = 'still holding up.';                              color = '🟡'; }
            if (latency > 300) { mood = '🔴 Lag spike'; vibe = 'performance hit';   note = isDay ? 'we fixing that asap.' : 'yeah… that was rough.'; color = '🔴'; }

            // Quotes
            const dayQuotes   = ['bright, fast, unstoppable.', 'clean speed, clean work.', 'sunlight + performance.', 'good vibes, zero lag.'];
            const nightQuotes = ['running silent, hitting fast.', 'low noise. high precision.', 'we move in the dark.', 'lag fears me fr.'];
            const quotes = isDay ? dayQuotes : nightQuotes;
            const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];

            // Stats
            const uptime = process.uptime().toFixed(0);
            const ram = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
            const speed = `${latency}ms`;

            // Response
            let response;
            if (isDay) {
                response = [
                    `╭─〔 🌞 SYSTEM PING 〕─╮`,
                    `│ ${color} Speed   : ${speed}`,
                    `│ 🧠 Status  : ${mood}`,
                    `│ 🌐 Engine  : ${vibe}`,
                    `│ ☀️ Mode    : active daylight`,
                    `│ ⏳ Uptime : ${uptime}s`,
                    `│ 💾 RAM     : ${ram} MB`,
                    `│ ✍️ Note    : ${note}`,
                    `╰─☀️☀️☀️☀️☀️☀️─╯`,
                    `> ${randomQuote}`,
                ].join('\n');
            } else {
                response = [
                    `┏━〔 🌙 NIGHT PING 〕━┓`,
                    `┃ ${color} Speed   :: ${speed}`,
                    `┃ 🧠 Status  :: ${mood}`,
                    `┃ ⚙️ Core    :: ${vibe}`,
                    `┃ 🌌 Mode    :: silent ops`,
                    `┃ ⏳ Uptime :: ${uptime}s`,
                    `┃ 💾 RAM     :: ${ram} MB`,
                    `┃ ✍️ Log     :: ${note}`,
                    `┗━🌌🌌🌌🌌🌌🌌━┛`,
                    `> ${randomQuote}`,
                ].join('\n');
            }

            return sock.sendMessage(jid, { text: response }, { quoted: msg });
        }

        if (cmd === '.menu') {
            try {
                const { ownerWhatsAppJids } = require('../config');
                const ownerSet = new Set((ownerWhatsAppJids || []).map(j => String(j || '').trim()).filter(Boolean));
                const ownerDigits = new Set(Array.from(ownerSet).map(j => String(j || '').replace(/[^0-9]/g, '')).filter(Boolean));

                const senderDigits = String(sender || '').replace(/[^0-9]/g, '');
                const botDigits = String(botId || '').replace(/[^0-9]/g, '');
                const senderNorm = String(sender || '').replace(/:\d+(?=@)/g, '');

                const isGlobalOwner = ownerSet.has(sender) || ownerSet.has(senderNorm) || ownerDigits.has(senderDigits);
                const isThisNodeOwner = senderDigits === botDigits && !!botDigits;
                const userRole = (isGlobalOwner || isThisNodeOwner) ? 'owner' : (user.role || 'public');

                const sendStart = Date.now();
                await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } }).catch(() => {});
                const ping = Date.now() - sendStart;

                const menuText = generateMenu(
                    { name: user.name || 'Operator', level: user.stats?.commandsUsed ?? 0, mode: userRole.toUpperCase(), ping },
                    { userRole }
                );

                // Send menu as image+caption together, fallback to text if image fails
                getPollinationsImage().then(async menuImage => {
                    try {
                        if (menuImage) {
                            await sock.sendMessage(jid, { image: menuImage, caption: menuText }, { quoted: msg });
                        } else {
                            await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
                        }
                    } catch {
                        await sock.sendMessage(jid, { text: menuText }, { quoted: msg }).catch(() => {});
                    }
                }).catch(async () => {
                    await sock.sendMessage(jid, { text: menuText }, { quoted: msg }).catch(() => {});
                });

                const activeSong = menuSongManager.getActiveSong();
                if (activeSong?.absolutePath && fs.existsSync(activeSong.absolutePath)) {
                    const songBuffer = await fs.promises.readFile(activeSong.absolutePath);
                    await sock.sendMessage(jid, {
                        audio: songBuffer,
                        mimetype: activeSong.mimeType || 'audio/mpeg',
                        ptt: false,
                        fileName: `${activeSong.name || 'menu-song'}.mp3`,
                        caption: `🎵 ${activeSong.name || 'Menu Track'}`,
                    }, { quoted: msg });
                }
            } catch (err) {
                logger.error(`[.menu] Error: ${err.message}`);
                return sock.sendMessage(jid, { text: '❌ Menu failed. Try again.' }).catch(() => {});
            }
            return;
        }

        if (cmd === '.owner') {
            return sock.sendMessage(jid, {
                text: '👑 *PAPPY OWNER*\n\n' +
                      '📢 *Channel:* t.me/pappylung\n' +
                      '💬 *DM:* t.me/pappylung\n\n' +
                      '_For enquiries, collabs or support — hit the DM._'
            }, { quoted: msg });
        }

        if (cmd === '.prefix') {
            const { getCommandPrefix } = require('../core/whatsapp');
            const activePrefix = getCommandPrefix();
            return sock.sendMessage(jid, { text: `⚙️ Active prefix: ${activePrefix}` }, { quoted: msg });
        }

        if (cmd === '.setprefix') {
            const nextPrefix = String(args[0] || '').trim();
            if (!nextPrefix) {
                return sock.sendMessage(jid, { text: 'Usage: .setprefix !\nRules: 1-3 chars, no spaces.' }, { quoted: msg });
            }

            const { setCommandPrefix, getCommandPrefix } = require('../core/whatsapp');
            const ok = setCommandPrefix(nextPrefix);
            if (!ok) {
                return sock.sendMessage(jid, { text: '❌ Invalid prefix. Use 1-3 chars without spaces.\nExample: .setprefix !' }, { quoted: msg });
            }

            const activePrefix = getCommandPrefix();
            return sock.sendMessage(jid, {
                text: `✅ Prefix changed to: ${activePrefix}\nUse commands like: ${activePrefix}menu`
            }, { quoted: msg });
        }

        if (cmd === '.queues') {
            try {
                const { getQueueDebugSnapshot } = require('../core/bullEngine');
                const snapshot = await getQueueDebugSnapshot();
                const lines = [
                    '🧵 *QUEUE SHARDS*',
                    `Node ID: ${snapshot.nodeId}`,
                    `Shards: ${snapshot.shardCount}`,
                    '',
                ];

                if (!snapshot.shards.length) {
                    lines.push('_No active queue shards yet._');
                } else {
                    snapshot.shards.forEach((shard, idx) => {
                        const counts = shard.counts || {};
                        lines.push(
                            `${idx + 1}. ${shard.queueName}`,
                            `   worker: ${shard.workerAttached ? 'yes' : 'no'}`,
                            `   waiting=${counts.waiting || 0} active=${counts.active || 0} delayed=${counts.delayed || 0} failed=${counts.failed || 0} completed=${counts.completed || 0}`
                        );
                    });
                }

                return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
            } catch (err) {
                logger.error(`[.queues] Error: ${err.message}`);
                return sock.sendMessage(jid, { text: `❌ Queue debug failed: ${err.message}` }, { quoted: msg });
            }
        }

        if (cmd === '.pappy' || cmd === '.papoy') {
            const action = args[0]?.toLowerCase();
            const { setPappyMode, getNodeState } = require('../core/whatsapp');
            const nodeState = getNodeState(botId);

            if (action === 'on') {
                setPappyMode(jid, true, botId);

                try {
                    const meta = await require('../core/groupCache').getGroupMeta(sock, jid);
                    const botJid = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
                    const members = meta.participants.map(p => p.id).filter(id => id !== botJid);
                    const intros = ['tch xup gng', 'yo xup gng', 'aye xup gng', 'sup gng', 'oi xup gng'];
                    const introText = intros[Math.floor(Math.random() * intros.length)];

                    await sock.sendMessage(jid, {
                        text: introText,
                        mentions: members,
                    });
                } catch (err) {
                    logger.warn('[Pappy] tagall on activate failed', { error: err.message });
                }
                return;
            }

            if (action === 'off') {
                setPappyMode(jid, false, botId);
                return sock.sendMessage(jid, { text: '❌ Pappy mode deactivated' });
            }

            const isOn = nodeState.pappyMode?.[jid] === true;
            return sock.sendMessage(jid, { text: `pappy mode: ${isOn ? 'on' : 'off'}` });
        }



        if (cmd === '.tts') {
            const speakText = args.join(' ');
            if (!speakText) return sock.sendMessage(jid, { text: 'Usage: .tts [text]\nExample: .tts hello how are you' }, { quoted: msg });
            try {
                const aiModule = require('../core/ai');
                const buf = await aiModule.textToSpeech(speakText);
                return sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
            } catch {
                return sock.sendMessage(jid, { text: "Couldn't generate voice, try again." }, { quoted: msg });
            }
        }

        if (cmd === '.video') {
            const query = args.join(' ');
            if (!query) return sock.sendMessage(jid, { text: 'Usage: .video [search]\nExample: .video funny cats' }, { quoted: msg });
            const searching = await sock.sendMessage(jid, { text: `🔍 Searching: ${query}...` }, { quoted: msg });
            try {
                const { searchYoutube, downloadVideo } = require('../core/youtube');
                const results = await searchYoutube(query, 3);
                if (!results.length) throw new Error('No results');

                let picked = results[0];
                let downloaded = null;
                let lastErr = null;
                for (const candidate of results) {
                    try {
                        downloaded = await downloadVideo(candidate.videoId, 48 * 1024 * 1024);
                        picked = candidate;
                        break;
                    } catch (err) {
                        lastErr = err;
                    }
                }

                if (!downloaded) {
                    // Fallback to AI helper path if direct youtube path fails.
                    const aiModule = require('../core/ai');
                    const fallback = await aiModule.searchVideo(query);
                    downloaded = {
                        buffer: fallback.buffer,
                        title: fallback.title || picked.title || query,
                        mimetype: fallback.mimetype || 'video/mp4',
                    };
                }

                await sock.sendMessage(jid, {
                    video: downloaded.buffer,
                    caption: downloaded.title || picked.title || query,
                    mimetype: downloaded.mimetype || 'video/mp4',
                    gifPlayback: false,
                }, { quoted: msg });
                await sock.sendMessage(jid, { delete: searching.key }).catch(() => {});
            } catch (err) {
                logger.warn('[Video] Failed', { error: err.message });
                await sock.sendMessage(jid, { text: "Couldn't find that video, try .play for audio only." }, { quoted: msg });
                await sock.sendMessage(jid, { delete: searching.key }).catch(() => {});
            }
            return;
        }

        if (cmd === '.song') {
            const isNext = args[0]?.toLowerCase() === 'next';
            // Also handle replying "next" to the song info message
            const quotedText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || '';
            const isReplyNext = text.trim().toLowerCase() === 'next' && quotedText.includes('Tap your choice above');
            const queryFromReply = isReplyNext ? quotedText.match(/Pick a song: (.+)/)?.[1] || '' : '';
            const query = isReplyNext ? queryFromReply : (isNext ? args.slice(1).join(' ') : args.join(' '));
            const page = (isNext || isReplyNext) ? 1 : 0;
            if (!query) return sock.sendMessage(jid, { text: '🎵 Usage: .song [song name]\nExample: .song Blinding Lights' }, { quoted: msg });
            const searching = await sock.sendMessage(jid, { text: `🔍 Searching: *${query}*${isNext ? ' (next results)' : ''}...` }, { quoted: msg });
            try {
                const { searchYoutube } = require('../core/youtube');
                const results = await searchYoutube(query, page === 0 ? 5 : 10);
                const pageResults = page === 0 ? results.slice(0, 5) : results.slice(5, 10);
                if (!pageResults?.length) throw new Error('No results');
                await sock.sendMessage(jid, { delete: searching.key }).catch(() => {});

                if (!global._songSearchCache) global._songSearchCache = new Map();
                const token = `song_${Date.now()}_${jid}`;
                global._songSearchCache.set(token, { results: pageResults, jid, botId, query, page });
                setTimeout(() => global._songSearchCache?.delete(token), 5 * 60 * 1000);

                const options = pageResults.map(r => `${r.title.slice(0, 80)} [${r.duration || '?'}]`);
                const pollMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: `🎵 Pick a song: ${query}`,
                        values: options,
                        selectableCount: 1,
                    }
                }, { quoted: msg });

                if (!global._songPollLookup) global._songPollLookup = new Map();
                if (pollMsg?.key?.id) {
                    const optionMap = {};
                    pageResults.forEach((r, i) => {
                        const optionText = String(options[i] || '').replace(/\s*\[.*?\]\s*$/, '').trim().toLowerCase();
                        if (optionText) optionMap[optionText] = r;
                    });
                    global._songPollLookup.set(pollMsg.key.id, {
                        jid,
                        results: pageResults,
                        optionMap,
                        createdAt: Date.now(),
                    });
                    setTimeout(() => global._songPollLookup?.delete(pollMsg.key.id), 10 * 60 * 1000).unref?.();
                }
                // Reply to the poll itself with next instructions
                await sock.sendMessage(jid, {
                    text: `ℹ️ Tap your choice above to download
🔁 Reply *next* to this message for more results`,
                }, { quoted: pollMsg });
            } catch {
                await sock.sendMessage(jid, { text: "Couldn't find songs. Try again." }, { quoted: msg });
                await sock.sendMessage(jid, { delete: searching.key }).catch(() => {});
            }
            return;
        }

        if (cmd === '.tourl' || cmd === '.imgurl' || cmd === '.videourl' || cmd === '.fileurl') {
            const quotedMsg = getQuotedMessage(msg);
            const sourceMsg = quotedMsg || msg.message;
            const mediaType = detectMediaType(sourceMsg);

            if (!mediaType) {
                return sock.sendMessage(jid, {
                    text: '❌ Reply to an image, video, or document.\nUsage: .tourl (or .imgurl/.videourl/.fileurl)'
                }, { quoted: msg });
            }

            if (cmd === '.imgurl' && mediaType !== 'image') {
                return sock.sendMessage(jid, { text: '❌ .imgurl only works with images.' }, { quoted: msg });
            }
            if (cmd === '.videourl' && mediaType !== 'video') {
                return sock.sendMessage(jid, { text: '❌ .videourl only works with videos.' }, { quoted: msg });
            }
            if (cmd === '.fileurl' && mediaType !== 'document') {
                return sock.sendMessage(jid, { text: '❌ .fileurl only works with documents.' }, { quoted: msg });
            }

            const wait = await sock.sendMessage(jid, { text: '⏳ Uploading to URL host...' }, { quoted: msg }).catch(() => null);
            try {
                const mediaBuffer = await downloadMediaMessage(
                    { key: msg.key, message: sourceMsg },
                    'buffer',
                    {},
                    { logger: null, reuploadRequest: sock.updateMediaMessage }
                );

                const fileName = makeUploadName(sourceMsg, mediaType);
                const publicUrl = await uploadBufferToUrl(mediaBuffer, fileName);
                const previewTitle = mediaType === 'image'
                    ? 'Image Upload'
                    : mediaType === 'video'
                        ? 'Video Upload'
                        : 'File Upload';

                // Embed the buffer we already downloaded directly as the thumbnail
                // so WhatsApp shows the real image card. sourceUrl = page (no /dl/)
                // so tapping opens the page, not a file download.
                const contextInfo = createContextInfo({
                    title: previewTitle,
                    description: publicUrl,
                    url: publicUrl,
                    jpegThumbnail: mediaType === 'image' ? mediaBuffer : undefined,
                });

                await sock.sendMessage(
                    jid,
                    {
                        text: publicUrl,
                        contextInfo,
                    },
                    { quoted: msg }
                );
                if (wait?.key) await sock.sendMessage(jid, { delete: wait.key }).catch(() => {});
            } catch (err) {
                logger.error(`[toURL] Failed: ${err.message}`);
                if (wait?.key) await sock.sendMessage(jid, { delete: wait.key }).catch(() => {});
                await sock.sendMessage(jid, { text: '❌ Upload failed. Try again with another file.' }, { quoted: msg });
            }
            return;
        }

        if (cmd === '.sys') {
            const mem    = process.memoryUsage();
            const uptime = process.uptime();
            const hrs    = Math.floor(uptime / 3600);
            const mins   = Math.floor((uptime % 3600) / 60);
            const secs   = Math.floor(uptime % 60);
            return sock.sendMessage(jid, {
                text: `⚙️ *SYSTEM TELEMETRY*\n\n` +
                      `⏱️ *Uptime:* ${hrs}h ${mins}m ${secs}s\n` +
                      `🧠 *RAM:* ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB\n` +
                      `⚡ *Status:* Online\n` +
                      `👨‍💻 *Channel:* https://t.me/pappylung`
            });
        }

        if (cmd === '.sudo') {
            if (!isGlobalOwnerFromConfig(sender)) {
                return sock.sendMessage(jid, { text: '❌ Only global owner can manage sudo users.' }, { quoted: msg });
            }
            const ownerManager = require('../modules/ownerManager');
            const target = args[0]?.replace(/[^0-9]/g, '');
            if (!target) return sock.sendMessage(jid, { text: 'Usage: .sudo 2348012345678' }, { quoted: msg });
            const targetJid = `${target}@s.whatsapp.net`;
            await ownerManager.addSudo(targetJid);
            return sock.sendMessage(jid, { text: `✅ Added sudo: @${target}`, mentions: [targetJid] }, { quoted: msg });
        }

        if (cmd === '.delsudo') {
            if (!isGlobalOwnerFromConfig(sender)) {
                return sock.sendMessage(jid, { text: '❌ Only global owner can manage sudo users.' }, { quoted: msg });
            }
            const ownerManager = require('../modules/ownerManager');
            const target = args[0]?.replace(/[^0-9]/g, '');
            if (!target) return sock.sendMessage(jid, { text: 'Usage: .delsudo 2348012345678' }, { quoted: msg });
            const targetJid = `${target}@s.whatsapp.net`;
            await ownerManager.removeSudo(targetJid);
            return sock.sendMessage(jid, { text: `🗑️ Removed sudo: @${target}`, mentions: [targetJid] }, { quoted: msg });
        }

        if (cmd === '.bind') {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const sticker   = quotedMsg?.stickerMessage;
            if (!sticker) return sock.sendMessage(jid, { text: '꒰ ❌ ꒱ Reply to a sticker to bind.' });
            const commandToBind = args.join(' ');
            if (!commandToBind) return sock.sendMessage(jid, { text: '꒰ ❌ ꒱ Usage: .bind .command' });
            const stickerIdBuffer = Buffer.from(sticker.fileSha256);
            const stickerId = stickerIdBuffer.toString('base64');
            if (!stickerDbCache) await initStickerDb();
            stickerDbCache[stickerId] = commandToBind.startsWith('.') ? commandToBind : `.${commandToBind}`;
            await saveStickerDb();
            await sock.sendMessage(jid, { text: `⚡ *Ghost Trigger Bound*\n\n🔗 Command: \`${stickerDbCache[stickerId]}\`\n✅ Send this sticker to execute` });
            sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
            return;
        }

        if (cmd === '.nodemode') {
            const { getNodeMode, setNodeMode } = require('../core/whatsapp');
            const botId = sock.user?.id?.split(':')[0];
            const action = args[0]?.toLowerCase();

            if (action === 'public') {
                setNodeMode(botId, 'public');
                return sock.sendMessage(jid, { text: '🌐 *Node Mode: PUBLIC*\n\nAnyone can use bot commands.' }, { quoted: msg });
            }

            if (action === 'private') {
                setNodeMode(botId, 'private');
                return sock.sendMessage(jid, { text: '🔒 *Node Mode: PRIVATE*\n\nOnly node owner can use bot commands.' }, { quoted: msg });
            }

            const currentMode = getNodeMode(botId);
            return sock.sendMessage(jid, {
                text: `⚙️ *Current Node Mode: ${currentMode.toUpperCase()}*\n\nUsage:\n• .nodemode public — allow everyone\n• .nodemode private — owner only`
            }, { quoted: msg });
        }
        // ...existing code...
    }
};
