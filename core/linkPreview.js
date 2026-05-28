'use strict';
// core/linkPreview.js — Redis-cached, production-grade link preview engine

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('./logger');

// ─── Cache: Redis primary, in-process Map fallback ───────────────────────────
let _redis = null;
const REDIS_TTL = 600; // 10 min
const memCache = new Map();
const MEM_TTL = 10 * 60 * 1000;

function getRedis() {
    if (_redis) return _redis;
    try { _redis = require('../services/redis').connection; } catch {}
    return _redis;
}

async function cacheGet(key) {
    try {
        const r = getRedis();
        if (r) { const v = await r.get(`lp:${key}`); return v ? JSON.parse(v) : null; }
    } catch {}
    const e = memCache.get(key);
    if (e && Date.now() - e.ts < MEM_TTL) return e.data;
    memCache.delete(key);
    return null;
}

async function cacheSet(key, data) {
    try {
        const r = getRedis();
        if (r) { await r.set(`lp:${key}`, JSON.stringify(data), 'EX', REDIS_TTL); return; }
    } catch {}
    memCache.set(key, { data, ts: Date.now() });
    if (memCache.size > 500) { const k = memCache.keys().next().value; memCache.delete(k); }
}

// ─── UA pool ──────────────────────────────────────────────────────────────────
const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'WhatsApp/2.24.9.78 A',
];
const pickUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

const DEFAULT_THUMB = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAAQABADASIAAhEBAxEB/8QAFQAB' +
    'AQAAAAAAAAAAAAAAAAAAAAT/xAAfEAABAwMFAAAAAAAAAAAAAAABAAIDBAURBhIhMUH/xAAVAQEB' +
    'AAAAAAAAAAAAAAAAAAEC/8QAGBEAAgMAAAAAAAAAAAAAAAAAAAECERL/2gAMAwEAAhEDEQA/AJ3h' +
    'fkmZDrHaNaO8zy5i819mKT7upCRfrFL2s9fiPaPnDqvWrZDyhRDDmryBfaTyEb0LuXSbg3yrMX' +
    'STyfonbJjBDwpfe5CbTBXaZf1Gtabt/knunyfiYWbzNW9blVCEnGBB//2Q==', 'base64'
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractUrls(text) {
    if (!text) return [];
    return [...new Set((text.match(/https?:\/\/[^\s<>"']+/g) || []))];
}

function isAbsoluteUrl(url) { return /^https?:\/\//i.test(url); }

// ─── LINK VALIDATION ENGINE ─────────────────────────────────────────────────
async function isLinkValid(url, type = 'generic', sock = null) {
    if (!url || typeof url !== 'string') return false;
    
    try {
        // WhatsApp group invite validation
        if (type === 'whatsapp' || /chat\.whatsapp\.com/.test(url)) {
            const code = url.split('chat.whatsapp.com/')[1]?.split(/[?#]/)[0];
            if (!code) return false;
            
            // If socket available, validate via groupGetInviteInfo
            if (sock && typeof sock.groupGetInviteInfo === 'function') {
                try {
                    const info = await sock.groupGetInviteInfo(code);
                    // Valid if we got group info back
                    return !!(info?.id);
                } catch (e) {
                    // Invalid if we got specific errors
                    const msg = String(e.message || '').toLowerCase();
                    if (msg.includes('not-found') || msg.includes('expired') || msg.includes('invalid')) {
                        return false;
                    }
                    // For other errors, assume valid (network issue) and retry later
                    return true;
                }
            }
            // Fallback: regex-based code validation
            return /^[0-9A-Za-z]{20,24}$/.test(code);
        }
        
        // Generic HTTP URL validation - check HEAD response
        if (type === 'url' || /^https?:\/\//.test(url)) {
            try {
                const res = await axios.head(url, { 
                    timeout: 8000, 
                    maxRedirects: 3,
                    headers: { 'User-Agent': pickUA() },
                    validateStatus: () => true // accept all status codes
                });
                const status = res?.status || 0;
                // Valid if 2xx or 3xx (redirect)
                return status >= 200 && status < 400;
            } catch (e) {
                // Network errors = assume valid (may be temporarily down)
                const msg = String(e.message || '').toLowerCase();
                if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound')) {
                    // Temporary network issue - treat as valid for now
                    return true;
                }
                // Certificate/SSL errors = assume valid
                if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('ecer')) {
                    return true;
                }
                return false;
            }
        }
        
        return true; // Default: assume valid if type unknown
    } catch (err) {
        logger.warn(`[LinkValidation] Error validating ${url}: ${err.message}`);
        return true; // Default to valid on error (don't break autojoin)
    }
}

// Batch validate links and return only valid ones
async function validateLinks(links, sock = null) {
    if (!Array.isArray(links)) return [];
    const results = await Promise.allSettled(
        links.map(url => isLinkValid(url, 'whatsapp', sock))
    );
    return links.filter((_, i) => results[i]?.value === true);
}

// Cleanup intel DB: remove invalid links from a group entry
async function cleanupGroupLinks(groupJid, groupLinks, sock = null) {
    if (!Array.isArray(groupLinks) || !groupLinks.length) return [];
    const valid = await validateLinks(groupLinks, sock);
    return valid;
}

function resolveUrl(base, relative) {
    try { return isAbsoluteUrl(relative) ? relative : new URL(relative, base).href; } catch { return null; }
}

function detectPlatform(url) {
    if (/youtu\.be\/|youtube\.com\/(watch|shorts|embed)/.test(url)) return 'youtube';
    if (/tiktok\.com\//.test(url)) return 'tiktok';
    if (/instagram\.com\/(p|reel|tv)\//.test(url)) return 'instagram';
    if (/twitter\.com|x\.com\/\w+\/status\//.test(url)) return 'twitter';
    if (/chat\.whatsapp\.com\//.test(url)) return 'whatsapp_group';
    if (/open\.spotify\.com\/(track|album|playlist|episode)/.test(url)) return 'spotify';
    if (/\.(?:jpe?g|png|gif|webp|bmp)(\?.*)?$/i.test(url)) return 'direct_image';
    return 'generic';
}

function getYouTubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

// ─── Platform fetchers ────────────────────────────────────────────────────────
async function fetchYouTubeMeta(url) {
    const id = getYouTubeId(url);
    if (!id) return null;
    try {
        const { data } = await axios.get(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
            { timeout: 6000, headers: { 'User-Agent': pickUA() } }
        );
        return { title: data.title || 'YouTube Video', description: `▶️ ${data.author_name || 'YouTube'}`, thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };
    } catch {
        return { title: 'YouTube Video', description: '▶️ Watch on YouTube', thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };
    }
}

async function fetchTikTokMeta(url) {
    try {
        const { data } = await axios.get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { timeout: 7000, headers: { 'User-Agent': pickUA() } });
        return { title: data.title || 'TikTok Video', description: `🔥 @${data.author_name || 'TikTok'}`, thumbnailUrl: data.thumbnail_url || null };
    } catch { return { title: 'TikTok Video', description: '🔥 Trending on TikTok', thumbnailUrl: null }; }
}

async function fetchSpotifyMeta(url) {
    try {
        const { data } = await axios.get(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { timeout: 6000, headers: { 'User-Agent': pickUA() } });
        return { title: data.title || 'Spotify', description: `🎵 ${data.artist_name || 'Listen on Spotify'}`, thumbnailUrl: data.thumbnail_url || null };
    } catch { return { title: 'Spotify', description: '🎵 Listen on Spotify', thumbnailUrl: null }; }
}

async function fetchInstagramMeta(url) {
    try {
        const { data } = await axios.get(`https://api.instagram.com/oembed?url=${encodeURIComponent(url)}&maxwidth=480`, { timeout: 6000, headers: { 'User-Agent': pickUA() } });
        return { title: data.title || data.author_name || 'Instagram', description: `📸 @${data.author_name || 'Instagram'}`, thumbnailUrl: data.thumbnail_url || null };
    } catch { return { title: 'Instagram', description: '📸 View on Instagram', thumbnailUrl: null }; }
}

async function fetchImageBuffer(imageUrl) {
    if (!imageUrl || !isAbsoluteUrl(imageUrl)) return null;
    try {
        const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 12000, headers: { 'User-Agent': pickUA(), Accept: 'image/*' }, maxRedirects: 4 });
        if (!(res.headers['content-type'] || '').startsWith('image/')) return null;
        return Buffer.from(res.data);
    } catch { return null; }
}

async function fetchWhatsAppGroupMeta(url) {
    const code = url.split('chat.whatsapp.com/')[1]?.split(/[?#]/)[0];
    if (!code) return null;
    if (global.waSocks?.size > 0) {
        const sock = global.waSocks.values().next().value;
        try {
            const info = await sock.groupGetInviteInfo(code);
            let thumbnail = null;
            if (info?.id) {
                try { const pp = await sock.profilePictureUrl(info.id, 'image'); if (pp) thumbnail = await fetchImageBuffer(pp); } catch {}
            }
            const safeThumb = await normalizeThumbnailBuffer(thumbnail);
            return {
                title: info?.subject || 'WhatsApp Group',
                description: info?.desc || `${info?.size || 0} members`,
                thumbnail: safeThumb || DEFAULT_THUMB
            };
        } catch {}
    }
    const scraped = await scrapeOgMeta(url);
    if (scraped) {
        const thumb = scraped.thumbnailUrl ? await fetchImageBuffer(scraped.thumbnailUrl) : null;
        const safeThumb = await normalizeThumbnailBuffer(thumb);
        return {
            title: scraped.title || 'WhatsApp Group',
            description: scraped.description || '💬 Tap to join',
            thumbnail: safeThumb || DEFAULT_THUMB
        };
    }
    return { title: 'WhatsApp Group', description: '💬 Tap to join', thumbnail: DEFAULT_THUMB };
}

// ─── Generic OG / Twitter card / meta scraper ─────────────────────────────────
async function scrapeOgMeta(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await axios.get(url, {
            signal: controller.signal, timeout: 15000, maxRedirects: 5,
            maxContentLength: 512 * 1024,
            headers: { 'User-Agent': pickUA(), Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
            responseType: 'text', decompress: true,
        });
        clearTimeout(timer);
        const $ = cheerio.load(res.data.slice(0, 60000));
        const getMeta = (...sel) => { for (const s of sel) { const v = $(s).first().attr('content') || $(s).first().attr('href'); if (v?.trim()) return v.trim(); } return null; };

        const title = getMeta('meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="title"]') || $('title').first().text().trim() || '';
        const description = getMeta('meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]') || '';
        const rawImage = getMeta('meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]', 'meta[property="og:image:secure_url"]', 'link[rel="image_src"]');
        const siteName = getMeta('meta[property="og:site_name"]', 'meta[name="application-name"]') || (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();

        return { title: title.slice(0, 200), description: description.slice(0, 300), thumbnailUrl: rawImage ? resolveUrl(url, rawImage) : null, siteName };
    } catch (err) {
        clearTimeout(timer);
        logger.warn(`[LinkPreview] Scrape failed for ${url}: ${err.message}`);
        return null;
    }
}

// ─── Context builders ─────────────────────────────────────────────────────────
function createContextInfo(meta) {
    const reply = {
        title: (meta.title || 'Link Preview').slice(0, 100),
        body: (meta.description || '').slice(0, 200),
        mediaType: 1,
        sourceUrl: meta.url,
        renderLargerThumbnail: true,
        showAdAttribution: false,
    };
    // For chat: use thumbnailUrl so WA renders natively with the Open button
    // jpegThumbnail buffer is only used as fallback when no URL is available
    if (meta.thumbnailUrl) {
        reply.thumbnailUrl = meta.thumbnailUrl;
    } else if (Buffer.isBuffer(meta.jpegThumbnail) && meta.jpegThumbnail.length > 0) {
        reply.jpegThumbnail = meta.jpegThumbnail;
    }
    return {
        matchedText: meta.url,
        canonicalUrl: meta.url,
        'matched-text': meta.url,
        'canonical-url': meta.url,
        externalAdReply: reply,
    };
}

function createNativeLinkPreview(meta) {
    const p = { 'canonical-url': meta.url, 'matched-text': meta.url, title: (meta.title || 'Link Preview').slice(0, 100), description: (meta.description || '').slice(0, 200) };
    if (meta.thumbnail) p.jpegThumbnail = meta.thumbnail;
    return p;
}

// ─── Main builder ─────────────────────────────────────────────────────────────
async function buildLinkPreview(text, forGroupStatus = false, opts = {}) {
    const urls = extractUrls(text);
    if (!urls.length) return null;

    const url = urls[0];
    const cacheKey = `${Buffer.from(url).toString('base64').slice(0, 40)}_${forGroupStatus ? 'gs' : 'msg'}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    let meta = null;
    const platform = detectPlatform(url);

    switch (platform) {
        case 'youtube':   meta = await fetchYouTubeMeta(url); break;
        case 'tiktok':    meta = await fetchTikTokMeta(url); break;
        case 'instagram': meta = await fetchInstagramMeta(url); break;
        case 'spotify':   meta = await fetchSpotifyMeta(url); break;
        case 'twitter': {
            try {
                const { data } = await axios.get(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`, { timeout: 6000, headers: { 'User-Agent': pickUA() } });
                meta = { title: data.author_name || 'X / Twitter', description: data.html?.replace(/<[^>]+>/g, '').slice(0, 200) || '🐦 View on X', thumbnailUrl: null };
            } catch { meta = { title: 'X / Twitter', description: '🐦 View post', thumbnailUrl: null }; }
            break;
        }
        case 'whatsapp_group': {
            const waInfo = await fetchWhatsAppGroupMeta(url);
            const result = forGroupStatus
                ? { url, title: waInfo?.title || 'WhatsApp Group', description: waInfo?.description || 'Tap to join 💬', thumbnail: waInfo?.thumbnail || DEFAULT_THUMB }
                : createContextInfo({ title: waInfo?.title || 'WhatsApp Group Invite', description: waInfo?.description || 'Tap to join 💬', jpegThumbnail: waInfo?.thumbnail || DEFAULT_THUMB, url });
            await cacheSet(cacheKey, result);
            return result;
        }
        case 'direct_image': {
            let imgBuf = await fetchImageBuffer(url);
            if (!imgBuf && url.includes('tmpfiles.org/') && !url.includes('/dl/')) imgBuf = await fetchImageBuffer(url.replace('tmpfiles.org/', 'tmpfiles.org/dl/'));
            const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'File'; } })();
            const result = forGroupStatus
                ? { url, title: host, description: url, thumbnail: imgBuf || null }
                : createContextInfo({ title: host, description: url, url, jpegThumbnail: imgBuf || undefined });
            await cacheSet(cacheKey, result);
            return result;
        }
        default:
            meta = await scrapeOgMeta(url);
            // Retry with different UA if first attempt failed
            if (!meta || (!meta.title && !meta.thumbnailUrl)) {
                try { meta = await scrapeOgMeta(url); } catch {}
            }
            break;
    }

    if (!meta) {
        try { const { hostname } = new URL(url); meta = { title: hostname.replace(/^www\./, ''), description: url.slice(0, 120), thumbnailUrl: null }; }
        catch { return null; }
    }

    let result = null;
    if (forGroupStatus) {
        // Status needs buffer — thumbnailUrl not supported in group status
        const thumbnail = meta.thumbnailUrl ? await fetchImageBuffer(meta.thumbnailUrl) : null;
        result = { url, title: meta.title || '', description: meta.description || '', thumbnail };
    } else {
        // Chat: keep thumbnailUrl so WA renders native card with Open button
        // Only fetch buffer if no URL available
        result = createContextInfo({ ...meta, url });
    }

    if (result) await cacheSet(cacheKey, result);
    return result;
}

async function buildNativeLinkPreview(text) {
    const urls = extractUrls(text);
    if (!urls.length) return null;
    const url = urls[0];
    if (detectPlatform(url) !== 'whatsapp_group') return null;
    const waInfo = await fetchWhatsAppGroupMeta(url);
    return createNativeLinkPreview({ url, title: waInfo?.title || 'WhatsApp Group Invite', description: waInfo?.description || 'Tap to join', thumbnail: waInfo?.thumbnail || null });
}

async function normalizeThumbnailBuffer(input) {
    if (!input) return null;
    const buf = Buffer.isBuffer(input) ? input
        : (input?.type === 'Buffer' && Array.isArray(input?.data)) ? Buffer.from(input.data)
        : null;
    if (!buf || buf.length === 0) return null;
    try {
        const sharp = require('sharp');
        // 480px wide to match linkPreviewImageThumbnailWidth — full width card in WA
        let resized = await sharp(buf)
            .resize(480, 480, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 80, progressive: false })
            .toBuffer();
        if (resized.length > 46080) {
            resized = await sharp(buf)
                .resize(480, 480, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 55, progressive: false })
                .toBuffer();
        }
        if (resized.length > 46080) {
            resized = await sharp(buf)
                .resize(300, 300, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 55, progressive: false })
                .toBuffer();
        }
        return resized.length <= 46080 ? resized : null;
    } catch {
        return buf.length <= 46080 ? buf : null;
    }
}
// Preview hint cache — stores full contextInfo from WA messages so Telegram godcast can reuse them
const _previewHintCache = new Map(); // url -> { contextInfo, text, cachedAt }
const PREVIEW_HINT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function rememberPreviewHint(text, contextInfo) {
    if (!contextInfo?.externalAdReply) return;
    const urls = extractUrls(String(text || ''));
    const url = urls[0] || contextInfo.externalAdReply.sourceUrl || contextInfo.externalAdReply.canonicalUrl || '';
    if (!url) return;
    const key = url.trim().toLowerCase();
    _previewHintCache.set(key, { contextInfo, text: String(text || ''), cachedAt: Date.now() });
    // Also persist to Redis so cache survives restarts
    try {
        const r = require('../services/redis').connection;
        r.set(`ph:${key}`, JSON.stringify({ contextInfo, text: String(text || ''), cachedAt: Date.now() }), 'EX', 86400).catch(() => {});
    } catch {}
    // Prune stale in-memory entries
    for (const [k, v] of _previewHintCache.entries()) {
        if (Date.now() - v.cachedAt > PREVIEW_HINT_TTL_MS) _previewHintCache.delete(k);
    }
}

function getPreviewHint(text) {
    const urls = extractUrls(String(text || ''));
    if (!urls.length) return null;
    const key = urls[0].trim().toLowerCase();
    // Check in-memory first
    const entry = _previewHintCache.get(key);
    if (entry) {
        if (Date.now() - entry.cachedAt > PREVIEW_HINT_TTL_MS) { _previewHintCache.delete(key); }
        else return entry.contextInfo;
    }
    return null;
}

// Async version that also checks Redis — used by Telegram godcast handler
async function getPreviewHintAsync(text) {
    const sync = getPreviewHint(text);
    if (sync) return sync;
    const urls = extractUrls(String(text || ''));
    if (!urls.length) return null;
    const key = urls[0].trim().toLowerCase();
    try {
        const r = require('../services/redis').connection;
        const raw = await r.get(`ph:${key}`);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.contextInfo?.externalAdReply) {
                _previewHintCache.set(key, parsed); // warm in-memory cache
                return parsed.contextInfo;
            }
        }
    } catch {}
    return null;
}

module.exports = { buildLinkPreview, buildNativeLinkPreview, extractUrls, createContextInfo, fetchImageBuffer, normalizeThumbnailBuffer, rememberPreviewHint, getPreviewHint, getPreviewHintAsync, isLinkValid, validateLinks, cleanupGroupLinks };
