'use strict';
// core/youtube.js — YouTube search + download via youtubei.js (no yt-dlp)
// Uses bgutils-js to bypass bot detection (PO token generation)

const { Innertube, UniversalCache } = require('youtubei.js');
const fs   = require('fs');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

const CACHE_DIR = path.join(__dirname, '../data/yt_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let _yt = null;

function getYoutubeCookiesPath() {
    const envPath = String(process.env.YTDLP_COOKIES_PATH || '').trim();
    const candidates = [
        envPath,
        path.join(__dirname, '../data/youtube_cookies.txt'),
        '/opt/omega-dev/data/youtube_cookies.txt',
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
        } catch {}
    }

    return '';
}

function getYoutubeCookieArg() {
    const cookiesPath = getYoutubeCookiesPath();
    return cookiesPath ? `--cookies "${cookiesPath}"` : '';
}

function getYtDlpBin() {
    const envBin = String(process.env.YTDLP_BIN || '').trim();
    if (envBin) return envBin;
    if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
    return 'yt-dlp';
}

async function runYtDlp(cmd) {
    await execAsync(cmd, { timeout: 120000 });
}

async function downloadAudioViaYtDlp(videoUrl, maxBytes = 30 * 1024 * 1024) {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outTpl = path.join(CACHE_DIR, `yt_audio_${stamp}.%(ext)s`);
    const ytDlp = getYtDlpBin();
    const cookieArg = getYoutubeCookieArg();
    const maxMb = Math.floor(maxBytes / (1024 * 1024));
    const formatCandidates = [
        'bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio',
        '140/251/250/249/bestaudio',
        'bestaudio/best',
    ];

    let lastErr;
    const useCookiesModes = cookieArg ? [true, false] : [false];
    for (const fmt of formatCandidates) {
        for (const useCookies of useCookiesModes) {
            const activeCookieArg = useCookies ? cookieArg : '';
            const cmd = `${ytDlp} ${activeCookieArg} --no-playlist --no-warnings --max-filesize ${maxMb}m -f "${fmt}" -o "${outTpl}" "${videoUrl}"`;
            try {
                await runYtDlp(cmd);
                const prefix = `yt_audio_${stamp}.`;
                const filesNow = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(prefix));
                if (filesNow.length) {
                    const filePath = path.join(CACHE_DIR, filesNow[0]);
                    const buffer = fs.readFileSync(filePath);
                    fs.unlink(filePath, () => {});
                    return { buffer, fileExt: path.extname(filePath).replace('.', '') || 'm4a' };
                }
            } catch (err) {
                lastErr = err;
            }
        }
    }

    const prefix = `yt_audio_${stamp}.`;
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(prefix));
    if (!files.length) throw lastErr || new Error('yt-dlp audio output not found');
    const filePath = path.join(CACHE_DIR, files[0]);
    const buffer = fs.readFileSync(filePath);
    fs.unlink(filePath, () => {});
    return { buffer, fileExt: path.extname(filePath).replace('.', '') || 'm4a' };
}

async function downloadVideoViaYtDlp(videoUrl, maxBytes = 48 * 1024 * 1024) {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outTpl = path.join(CACHE_DIR, `yt_video_${stamp}.%(ext)s`);
    const ytDlp = getYtDlpBin();
    const cookieArg = getYoutubeCookieArg();
    const maxMb = Math.floor(maxBytes / (1024 * 1024));
    const formatCandidates = [
        'bv*[ext=mp4][vcodec*=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/22/18',
        'b[ext=mp4][height<=720]/22/18/b[height<=720]/b',
    ];

    let lastErr;
    const useCookiesModes = cookieArg ? [true, false] : [false];
    for (const fmt of formatCandidates) {
        for (const useCookies of useCookiesModes) {
            const activeCookieArg = useCookies ? cookieArg : '';
            const cmd = `${ytDlp} ${activeCookieArg} --no-playlist --no-warnings --merge-output-format mp4 --max-filesize ${maxMb}m -f "${fmt}" -o "${outTpl}" "${videoUrl}"`;
            try {
                await runYtDlp(cmd);
                const prefix = `yt_video_${stamp}.`;
                const filesNow = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(prefix));
                if (filesNow.length) {
                    const filePath = path.join(CACHE_DIR, filesNow[0]);
                    const buffer = fs.readFileSync(filePath);
                    fs.unlink(filePath, () => {});
                    return { buffer, fileExt: path.extname(filePath).replace('.', '') || 'mp4' };
                }
            } catch (err) {
                lastErr = err;
            }
        }
    }

    const prefix = `yt_video_${stamp}.`;
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(prefix));
    if (!files.length) throw lastErr || new Error('yt-dlp video output not found');
    const filePath = path.join(CACHE_DIR, files[0]);
    const buffer = fs.readFileSync(filePath);
    fs.unlink(filePath, () => {});
    return { buffer, fileExt: path.extname(filePath).replace('.', '') || 'mp4' };
}

async function getClient() {
    if (_yt) return _yt;
    _yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
    });
    return _yt;
}

// Reset client on error so next call rebuilds it
function resetClient() { _yt = null; }

/**
 * Search YouTube and return top N results
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{videoId, title, uploader, duration, durationSecs}>>}
 */
async function searchYoutube(query, limit = 5) {
    const yt = await getClient();
    try {
        const results = await yt.search(query, { type: 'video' });
        const videos = results.videos || [];
        return videos.slice(0, limit).map(v => ({
            videoId:     v.id,
            title:       v.title?.text || v.title || 'Unknown',
            uploader:    v.author?.name || v.channel?.name || 'Unknown',
            durationSecs: v.duration?.seconds || 0,
            duration:    v.duration?.text || '?',
            thumbnail:   v.thumbnails?.[0]?.url || null,
            url:         `https://www.youtube.com/watch?v=${v.id}`,
        }));
    } catch (err) {
        resetClient();
        throw err;
    }
}

/**
 * Download audio from a YouTube video as a Buffer (MP3-compatible AAC/opus)
 * Falls back to yt-dlp if youtubei fails
 * @param {string} videoId
 * @returns {Promise<{buffer: Buffer, title: string, uploader: string, duration: string}>}
 */
async function downloadAudio(videoId) {
    const yt = await getClient();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let title = videoId;
    let uploader = 'Unknown';
    let duration = '?';
    let thumb = null;

    try {
        const info = await yt.getInfo(videoId);
        title = info.basic_info?.title || videoId;
        uploader = info.basic_info?.author || 'Unknown';
        const secs = info.basic_info?.duration || 0;
        duration = secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?';
        thumb = info.basic_info?.thumbnail?.[0]?.url || null;
    } catch {
        resetClient();
    }

    try {
        const stream = await yt.download(videoId, {
            type: 'audio',
            quality: 'best',
            format: 'any',
        });
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const buffer = Buffer.concat(chunks);
        return { buffer, title, uploader, duration, thumb, mimetype: 'audio/webm', fileExt: 'webm' };
    } catch (ytErr) {
        resetClient();
        try {
            const dl = await downloadAudioViaYtDlp(videoUrl);
            const ext = (dl.fileExt || 'm4a').toLowerCase();
            const mimetype = ext === 'mp3' ? 'audio/mpeg' : (ext === 'webm' ? 'audio/webm' : 'audio/mp4');
            return { buffer: dl.buffer, title, uploader, duration, thumb, mimetype, fileExt: ext };
        } catch (ytDlpErr) {
            throw ytDlpErr?.message ? ytDlpErr : ytErr;
        }
    }
}

/**
 * Download video from a YouTube video as a Buffer (MP4)
 * @param {string} videoId
 * @param {number} maxBytes  default 48MB
 * @returns {Promise<{buffer: Buffer, title: string, uploader: string, duration: string}>}
 */
async function downloadVideo(videoId, maxBytes = 48 * 1024 * 1024) {
    const yt = await getClient();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    try {
        const info = await yt.getInfo(videoId);
        const title    = info.basic_info?.title || videoId;
        const uploader = info.basic_info?.author || 'Unknown';
        const secs     = info.basic_info?.duration || 0;
        const duration = secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?';

        try {
            const dl = await downloadVideoViaYtDlp(videoUrl, maxBytes);
            return { buffer: dl.buffer, title, uploader, duration, mimetype: 'video/mp4', fileExt: 'mp4' };
        } catch {}

        const stream = await yt.download(videoId, {
            type:    'video+audio',
              quality: '720p',
            format:  'mp4',
        });

        const chunks = [];
        let total = 0;
        for await (const chunk of stream) {
            const buf = Buffer.from(chunk);
            total += buf.length;
            if (total > maxBytes) throw new Error('Video too large (>48MB)');
            chunks.push(buf);
        }
        const buffer = Buffer.concat(chunks);

        return { buffer, title, uploader, duration, mimetype: 'video/mp4', fileExt: 'mp4' };
    } catch (err) {
        resetClient();
        throw err;
    }
}

/**
 * Get info for a video by ID or URL without downloading
 */
async function getVideoInfo(videoIdOrUrl) {
    const yt = await getClient();
    try {
        const id = String(videoIdOrUrl).replace(/.*v=/, '').replace(/.*youtu\.be\//, '').split('&')[0].split('?')[0];
        const info = await yt.getInfo(id);
        const secs = info.basic_info?.duration || 0;
        return {
            videoId:  id,
            title:    info.basic_info?.title || id,
            uploader: info.basic_info?.author || 'Unknown',
            duration: secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?',
            durationSecs: secs,
            thumbnail: info.basic_info?.thumbnail?.[0]?.url || null,
        };
    } catch (err) {
        resetClient();
        throw err;
    }
}

module.exports = { searchYoutube, downloadAudio, downloadVideo, getVideoInfo, getYoutubeCookiesPath, getYoutubeCookieArg };
