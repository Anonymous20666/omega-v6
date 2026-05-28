'use strict';
// plugins/pappy-music.js — YouTube music downloader
// Primary: youtubei.js (no yt-dlp, no bot detection issues)
// Fallback: yt-dlp

const fs     = require('fs');
const path   = require('path');
const util   = require('util');
const { exec } = require('child_process');
const logger = require('../core/logger');
const { searchYoutube, downloadAudio, getYoutubeCookieArg } = require('../core/youtube');
const execAsync = util.promisify(exec);

const TEMP_DIR = path.join(__dirname, '../data/temp_media');
fs.mkdirSync(TEMP_DIR, { recursive: true });

function withTimeout(promise, ms, label = 'operation timeout') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
    ]);
}

async function safeSend(sock, jid, payload, opts = {}) {
    try {
        return await sock.sendMessage(jid, payload, opts);
    } catch (err) {
        logger.warn('[Music] sendMessage failed', { error: err.message });
        return null;
    }
}

async function downloadAudioByQueryViaYtDlp(query) {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outTpl = path.join(TEMP_DIR, `music_query_${stamp}.%(ext)s`);
    const ytDlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
    const cookieArg = getYoutubeCookieArg();

    const cmd = `${ytDlp} ${cookieArg} --no-playlist --no-warnings -x --audio-format mp3 --audio-quality 2 --max-filesize 40m --concurrent-fragments 3 -o "${outTpl}" "ytsearch1:${String(query || '').trim()}"`;
    await execAsync(cmd, { timeout: 120000 });

    const prefix = `music_query_${stamp}.`;
    const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(prefix));
    if (!files.length) throw new Error('yt-dlp query fallback produced no audio');

    const filePath = path.join(TEMP_DIR, files[0]);
    const buffer = fs.readFileSync(filePath);
    try { fs.unlinkSync(filePath); } catch {}
    return {
        buffer,
        fileExt: 'mp3',
        mimetype: 'audio/mpeg',
        title: String(query || 'track').slice(0, 80),
        uploader: 'YouTube',
        duration: '?',
        thumbnail: null,
    };
}

// ─── Exposed for AI + Telegram bridge ───────────────────────────────────────
async function searchAndDownload(query) {
    const results = await searchYoutube(query, 5);
    if (!results.length) throw new Error('No results');
    let lastErr;
    for (const r of results) {
        try {
            const dl = await downloadAudio(r.videoId);
            const ext = dl.fileExt || 'm4a';
            const outPath = path.join(TEMP_DIR, `music_${Date.now()}.${ext}`);
            await fs.promises.writeFile(outPath, dl.buffer);
            return outPath;
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('No downloadable audio candidate');
}

async function getTrackInfo(query) {
    try {
        const results = await searchYoutube(query, 1);
        if (!results.length) throw new Error('No results');
        const r = results[0];
        return { title: r.title, uploader: r.uploader, duration: r.duration, thumb: r.thumbnail };
    } catch {
        return { title: query, uploader: 'Unknown', duration: '?', thumb: null };
    }
}

function buildPlayQueryVariants(query) {
    const base = String(query || '').trim().replace(/\s+/g, ' ');
    const variants = [base];

    const bySplit = base.split(/\s+by\s+/i)[0].trim();
    if (bySplit && bySplit !== base) variants.push(bySplit);

    const dashSplit = base.split(/\s+-\s+/)[0].trim();
    if (dashSplit && dashSplit !== base) variants.push(dashSplit);

    const words = base.split(' ').filter(Boolean);
    if (words.length > 3) {
        variants.push(words.slice(0, 3).join(' '));
        variants.push(words.slice(0, Math.min(words.length, 5)).join(' '));
    }

    return [...new Set(variants.filter(Boolean))];
}

// ─── Plugin ──────────────────────────────────────────────────────────────────
module.exports = {
    category: 'MUSIC',
    commands: [
        { cmd: '.play',   role: 'public' },
        { cmd: '.search', role: 'public' },
    ],

    searchAndDownload,
    getTrackInfo,

    execute: async ({ sock, msg, args, text, user }) => {
        const jid = msg.key.remoteJid;
        const query = args.join(' ');

        if (!query) {
            await safeSend(sock, jid, { text: '🎵 Usage: .play <song name>' }, { quoted: msg });
            return;
        }

        await safeSend(sock, jid, { text: `🔍 *Searching for:* ${query}\n⏳ Please wait...` }, { quoted: msg });

        try {
            let dl = null;
            let track = { title: query, uploader: 'YouTube', duration: '?', thumbnail: null };
            let lastErr;

            const queryVariants = buildPlayQueryVariants(query);

            // Primary path: use core YouTube resolver first (more stable under bot-check conditions).
            for (const variant of queryVariants) {
                let results = [];
                try {
                    results = await withTimeout(searchYoutube(variant, 3), 20000, 'Search timeout');
                } catch (searchErr) {
                    logger.warn('[Music] searchYoutube failed, continuing with next query variant', { error: searchErr.message, variant });
                    lastErr = searchErr;
                    continue;
                }

                if (!results.length) continue;
                track = results[0] || track;

                for (const candidate of results.slice(0, 3)) {
                    try {
                        dl = await withTimeout(downloadAudio(candidate.videoId), 60000, 'Download timeout');
                        track = candidate;
                        break;
                    } catch (err) {
                        lastErr = err;
                    }
                }

                if (dl) break;
            }

            // Fallback path: direct yt-dlp query download if primary path fails.
            if (!dl) {
                for (const variant of queryVariants) {
                    try {
                        dl = await withTimeout(downloadAudioByQueryViaYtDlp(variant), 90000, 'yt-dlp query timeout');
                        track = { title: variant, uploader: 'YouTube', duration: '?', thumbnail: null };
                        break;
                    } catch (fallbackErr) {
                        lastErr = fallbackErr;
                    }
                }
            }

            if (!dl) throw (lastErr || new Error('No downloadable result'));

            const buffer = dl.buffer;
            const ext = dl.fileExt || 'm4a';
            const audioMimetype = dl.mimetype || 'audio/mp4';
            const safeTitle = String(dl.title || track.title || query || 'track').replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'track';

            const isTgBridge = String(msg?.key?.id || '').startsWith('TG_CMD_') || msg?.pushName === 'Telegram';

            await safeSend(sock, jid, {
                audio:    buffer,
                mimetype: audioMimetype,
                ptt:      false,
                fileName: `${safeTitle}.${ext}`,
                contextInfo: {
                    externalAdReply: {
                        title:                 dl.title || track.title || safeTitle,
                        body:                  `🎤 ${dl.uploader || track.uploader || 'Unknown'} • ⏱ ${dl.duration || track.duration || '?'}`,
                        mediaType:             1,
                        sourceUrl:             'https://t.me/pappylung',
                        thumbnailUrl:          dl.thumb || track.thumbnail,
                        renderLargerThumbnail: true,
                        showAdAttribution:     false,
                    }
                }
            }, { quoted: msg });

            if (!isTgBridge && global.tgBot) {
                const { ownerTelegramId } = require('../config');
                global.tgBot.telegram.sendAudio(ownerTelegramId, { source: buffer, filename: `${safeTitle}.${ext}` }, {
                    title:      track.title,
                    performer:  track.uploader,
                    caption:    `🎵 *${track.title}*\n🎤 ${track.uploader}\n⏱ ${track.duration}`,
                    parse_mode: 'Markdown',
                }).catch(() => {});
            }

        } catch (err) {
            logger.error(`[Music] Failed: ${err.message}`);
            await safeSend(sock, jid, {
                text: `❌ *Could not find or download:* ${query}\n\nTry a more specific search.\nIf YouTube asks for bot verification, update cookies at: /opt/Omega-v5-test/data/youtube_cookies.txt`
            }, { quoted: msg });
        }

        return;
    }
};
