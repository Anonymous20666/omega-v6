const axios = require('axios');

function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
    if (/tiktok\.com/.test(url)) return 'tiktok';
    if (/instagram\.com/.test(url)) return 'instagram';
    return 'generic';
}

async function getPlatformPreview(url) {
    const type = detectPlatform(url);

    try {
        if (type === 'youtube') {
            const id = url.split('v=')[1]?.split('&')[0] || url.split('/').pop();
            return {
                title: "YouTube Video",
                body: "▶️ Watch on YouTube",
                thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
            };
        }

        if (type === 'tiktok') {
            return {
                title: "TikTok Video",
                body: "🔥 Trending TikTok",
                thumbnailUrl: "https://i.imgur.com/tiktok-thumb.png"
            };
        }

        if (type === 'instagram') {
            return {
                title: "Instagram Post",
                body: "📸 View on Instagram",
                thumbnailUrl: "https://i.imgur.com/instagram-thumb.png"
            };
        }

        return null;

    } catch {
        return null;
    }
}

module.exports = { getPlatformPreview };