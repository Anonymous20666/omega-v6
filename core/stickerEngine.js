'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.join(__dirname, '../data/temp_media');
const MAX_STICKER_BYTES = 500 * 1024;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function resolveBinaryPath(envVar, candidates) {
    const fromEnv = process.env[envVar];
    const list = [fromEnv, ...candidates].filter(Boolean);

    for (const candidate of list) {
        if (candidate === path.basename(candidate)) return candidate;
        if (fs.existsSync(candidate)) return candidate;
    }

    return path.basename(candidates[0]);
}

const FFMPEG_BIN = resolveBinaryPath('FFMPEG_PATH', ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']);
const FFPROBE_BIN = resolveBinaryPath('FFPROBE_PATH', ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']);

function nowTag() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) await fs.promises.unlink(filePath);
    } catch {}
}

async function probeStickerMeta(filePath) {
    try {
        const { stdout } = await execFileAsync(FFPROBE_BIN, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,nb_frames,duration',
            '-of', 'json',
            filePath,
        ], { timeout: 8000 });

        const parsed = JSON.parse(stdout || '{}');
        const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
        if (!stream) return null;

        const stats = await fs.promises.stat(filePath);
        const width = Number(stream.width || 0);
        const height = Number(stream.height || 0);
        const frameCount = Number(stream.nb_frames || 0);
        const duration = Number(stream.duration || 0);

        return {
            fileSize: stats.size,
            width,
            height,
            frameCount,
            duration,
            isAnimated: frameCount > 1 || duration > 0.2,
        };
    } catch {
        return null;
    }
}

async function encodeAnimatedWebp(inputPath, outputPath, options) {
    const {
        fps = 24,
        duration = 1.2,
        quality = 72,
        style = 'bounce',
    } = options || {};

    const totalFrames = Math.round(fps * duration);
    const f = Math.max(6, totalFrames);

    const styleFilters = {
        bounce: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='if(lte(on,${Math.round(f*0.3)}),1.18-0.18*(on/${Math.round(f*0.3)}),if(lte(on,${Math.round(f*0.55)}),1.0+0.06*sin(PI*(on-${Math.round(f*0.3)})/${Math.round(f*0.25)}),1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*3*sin(2*PI*t/${duration})*exp(-2*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        spin: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `rotate=(PI/180)*360*(1-exp(-4*t/${duration})):c=none:ow=rotw(iw):oh=roth(ih)`,
            `zoompan=z='0.6+0.4*(1-exp(-4*on/${f}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        shake: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.05':x='iw/2-(iw/zoom/2)+12*sin(8*PI*on/${f})*exp(-4*on/${f})':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*8*sin(8*PI*t/${duration})*exp(-4*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        pulse: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0+0.08*sin(2*PI*on/${f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        float: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.02':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+8*sin(2*PI*on/${f})':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*2*sin(2*PI*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        zoomin: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='0.2+0.8*(1-exp(-5*on/${f}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        zoomout: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.8-0.8*(1-exp(-5*on/${f}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        swing: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `rotate=(PI/180)*20*sin(3*PI*t/${duration})*exp(-2*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            `zoompan=z='1.0':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        slideleft: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0':x='(iw/2-(iw/zoom/2))*(1-exp(-5*on/${f}))':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        slideright: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0':x='iw-(iw*(1-exp(-5*on/${f})))':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        droptop: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-ih*(exp(-5*on/${f}))':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        risebottom: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+ih*(exp(-5*on/${f}))':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        wobble: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0+0.05*sin(6*PI*on/${f})*exp(-3*on/${f})':x='iw/2-(iw/zoom/2)+6*cos(6*PI*on/${f})*exp(-3*on/${f})':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*5*sin(6*PI*t/${duration})*exp(-3*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        spiral: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `rotate=(PI/180)*720*(1-exp(-4*t/${duration})):c=none:ow=rotw(iw):oh=roth(ih)`,
            `zoompan=z='0.3+0.7*(1-exp(-4*on/${f}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        heartbeat: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0+0.12*(exp(-20*pow(on/${f}-0.15,2))+0.6*exp(-20*pow(on/${f}-0.35,2)))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        rubberband: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0+0.15*sin(PI*on/${Math.round(f*0.4)})*exp(-2*on/${f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-10*sin(PI*on/${Math.round(f*0.4)})*exp(-2*on/${f})':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*4*sin(PI*t/${duration*0.4})*exp(-2*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        tada: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0+0.04*sin(5*PI*on/${f})*exp(-3*on/${f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*15*sin(5*PI*t/${duration})*exp(-3*t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        glitch: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0+0.03*sin(20*PI*on/${f})':x='iw/2-(iw/zoom/2)+8*sin(17*PI*on/${f})*exp(-4*on/${f})':y='ih/2-(ih/zoom/2)+5*cos(13*PI*on/${f})*exp(-4*on/${f})':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        orbit: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.05':x='iw/2-(iw/zoom/2)+20*sin(2*PI*on/${f})*exp(-2*on/${f})':y='ih/2-(ih/zoom/2)+20*cos(2*PI*on/${f})*exp(-2*on/${f})':d=1:s=512x512:fps=${fps}`,
            `rotate=(PI/180)*360*(on/${f})*exp(-2*on/${f}):c=none:ow=rotw(iw):oh=roth(ih)`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
        flipin: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `zoompan=z='1.0':x='iw/2-(iw/zoom/2)*(1-exp(-5*on/${f}))':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'format=rgba',
        ],
        tilt: [
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0','format=rgba',
            `rotate=(PI/180)*10*sin(PI*t/${duration})*(1-t/${duration}):c=none:ow=rotw(iw):oh=roth(ih)`,
            `zoompan=z='1.0+0.03*sin(PI*on/${f})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=512x512:fps=${fps}`,
            'scale=512:512:flags=lanczos','format=rgba',
        ],
    };

    const vf = (styleFilters[style] || styleFilters.bounce).join(',');

    await execFileAsync(FFMPEG_BIN, [
        '-y',
        '-loop', '1',
        '-i', inputPath,
        '-t', String(duration),
        '-an',
        '-vf', vf,
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(quality),
        '-compression_level', '6',
        '-preset', 'picture',
        '-loop', '0',
        '-vsync', '0',
        outputPath,
    ], { timeout: 25000 });
}

async function encodeStaticWebp(inputPath, outputPath, quality = 80) {
    await execFileAsync(FFMPEG_BIN, [
        '-y',
        '-i', inputPath,
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0',
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(quality),
        '-preset', 'picture',
        '-loop', '0',
        '-an',
        '-vsync', '0',
        outputPath,
    ], { timeout: 15000 });
}

async function generateAnimatedSticker(imageBuffer) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('Invalid image buffer');
    }

    const tag = nowTag();
    const inputPath = path.join(TEMP_DIR, `sticker_in_${tag}.png`);
    const outputPath = path.join(TEMP_DIR, `sticker_out_${tag}.webp`);

    // Static clean sticker — no animation, no rolling, no effects
    const staticAttempts = [90, 82, 74, 66, 58];

    try {
        await fs.promises.writeFile(inputPath, imageBuffer);

        let lastErr = null;
        for (const quality of staticAttempts) {
            try {
                await encodeStaticWebp(inputPath, outputPath, quality);
                const stats = await fs.promises.stat(outputPath);
                if (stats.size > MAX_STICKER_BYTES) continue;
                const meta = await probeStickerMeta(outputPath);
                const buffer = await fs.promises.readFile(outputPath);
                return {
                    buffer,
                    metadata: {
                        fileSize: stats.size,
                        resolution: `${meta?.width || 512}x${meta?.height || 512}`,
                        frameCount: meta?.frameCount || 1,
                        duration: meta?.duration || 0,
                        fallback: 'static',
                    }
                };
            } catch (err) {
                lastErr = err;
            }
        }

        throw lastErr || new Error('Failed to create WhatsApp-compatible animated sticker');
    } finally {
        await safeUnlink(inputPath);
        await safeUnlink(outputPath);
    }
}

async function encodeVideoStickerWebp(inputPath, outputPath, options) {
    const {
        fps = 14,
        duration = 5,
        quality = 70,
    } = options || {};

    const vf = [
        `fps=${fps}`,
        'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos',
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0',
        'format=rgba'
    ].join(',');

    await execFileAsync(FFMPEG_BIN, [
        '-y',
        '-i', inputPath,
        '-t', String(duration),
        '-an',
        '-vf', vf,
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(quality),
        '-compression_level', '6',
        '-preset', 'picture',
        '-loop', '0',
        '-vsync', '0',
        outputPath,
    ], { timeout: 25000 });
}

async function generateAnimatedStickerFromVideo(videoBuffer) {
    if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
        throw new Error('Invalid video buffer');
    }

    const tag = nowTag();
    const inputPath = path.join(TEMP_DIR, `anim_video_in_${tag}.mp4`);
    const outputPath = path.join(TEMP_DIR, `anim_video_out_${tag}.webp`);

    const attempts = [
        { fps: 14, duration: 5, quality: 70 },
        { fps: 12, duration: 4, quality: 66 },
        { fps: 10, duration: 4, quality: 62 },
        { fps: 10, duration: 3, quality: 58 },
    ];

    try {
        await fs.promises.writeFile(inputPath, videoBuffer);

        let lastErr = null;
        for (const attempt of attempts) {
            try {
                await encodeVideoStickerWebp(inputPath, outputPath, attempt);
                const stats = await fs.promises.stat(outputPath);
                if (stats.size > MAX_STICKER_BYTES) continue;
                const meta = await probeStickerMeta(outputPath);
                const buffer = await fs.promises.readFile(outputPath);
                return {
                    buffer,
                    metadata: {
                        fileSize: stats.size,
                        resolution: `${meta?.width || 512}x${meta?.height || 512}`,
                        frameCount: meta?.frameCount || 0,
                        duration: meta?.duration || 0,
                        source: 'video',
                    }
                };
            } catch (err) {
                lastErr = err;
            }
        }

        throw lastErr || new Error('Failed to create animated video sticker');
    } finally {
        await safeUnlink(inputPath);
        await safeUnlink(outputPath);
    }
}

async function encodeTelegramWebm(inputPath, outputPath, options) {
    const {
        fps = 30,
        duration = 2.8,
        quality = 33,
    } = options || {};

    const f = Math.max(6, Math.round(fps * duration));

    // Smooth premium float: gentle scale-in + soft vertical drift, no shake/rotate
    const vf = [
        'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos',
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0.0',
        'format=yuva420p',
        `zoompan=z='0.85+0.15*(1-exp(-4*on/${f}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+4*sin(PI*on/${f})':d=1:s=512x512:fps=${fps}`,
        'format=yuva420p',
    ].join(',');

    await execFileAsync(FFMPEG_BIN, [
        '-y',
        '-loop', '1',
        '-i', inputPath,
        '-t', String(duration),
        '-an',
        '-vf', vf,
        '-c:v', 'libvpx-vp9',
        '-crf', String(quality),
        '-b:v', '0',
        '-pix_fmt', 'yuva420p',
        '-auto-alt-ref', '0',
        outputPath,
    ], { timeout: 25000 });
}

async function generateTelegramSticker(imageBuffer) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('Invalid image buffer');
    }

    const MAX_TG_BYTES = 256 * 1024;
    const tag = nowTag();
    const inputPath = path.join(TEMP_DIR, `tg_sticker_in_${tag}.png`);
    const outputPath = path.join(TEMP_DIR, `tg_sticker_out_${tag}.webm`);

    const attempts = [
        { fps: 30, duration: 2.8, quality: 33 },
        { fps: 24, duration: 2.5, quality: 38 },
        { fps: 20, duration: 2.0, quality: 42 },
        { fps: 15, duration: 1.5, quality: 46 },
    ];

    try {
        await fs.promises.writeFile(inputPath, imageBuffer);

        let lastErr = null;
        for (const attempt of attempts) {
            try {
                await encodeTelegramWebm(inputPath, outputPath, attempt);
                const stats = await fs.promises.stat(outputPath);
                if (stats.size > MAX_TG_BYTES) continue;
                const buffer = await fs.promises.readFile(outputPath);
                return { buffer, mimetype: 'video/webm' };
            } catch (err) {
                lastErr = err;
            }
        }

        throw lastErr || new Error('Failed to create Telegram-compatible animated sticker');
    } finally {
        await safeUnlink(inputPath);
        await safeUnlink(outputPath);
    }
}

module.exports = {
    generateAnimatedSticker,
    generateAnimatedStickerFromVideo,
    generateTelegramSticker,
};
