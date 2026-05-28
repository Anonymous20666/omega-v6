'use strict';
// core/ai.js

const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const logger = require('./logger');
const { getMemory, updateMemory } = require('./ai.memory');

const QWEN_API_KEY  = process.env.QWEN_API_KEY;
const QWEN_ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_MODELS   = ['qwen-plus', 'qwen-turbo', 'qwen-max'];
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VISION_MODEL  = 'qwen-vl-max';
const AUDIO_MODEL   = 'qwen-omni-turbo';

const AI_PROVIDER_MODELS = {
    alibaba: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    openrouter: [
        'openai/gpt-4o-mini',
        'anthropic/claude-3.5-sonnet',
        'deepseek/deepseek-chat-v3-0324:free',
    ],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    chatgpt: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    nvidia: ['meta/llama-3.1-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    claude: ['claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest'],
    awsbedrock: ['anthropic.claude-3-5-sonnet-20240620-v1:0'],
    digitalocean: [
        'llama3.3-70b-instruct',
        'alibaba-qwen3-32b',
        'deepseek-r1-distill-llama-70b',
        'nvidia-nemotron-3-super-120b',
    ],
};

const DEFAULT_PROVIDER = 'digitalocean';

function normalizeProvider(provider) {
    const p = String(provider || '').trim().toLowerCase();
    return AI_PROVIDER_MODELS[p] ? p : DEFAULT_PROVIDER;
}

function getDefaultModelForProvider(provider) {
    const p = normalizeProvider(provider);
    return AI_PROVIDER_MODELS[p][0];
}

function getModelForProvider(provider, requestedModel) {
    const p = normalizeProvider(provider);
    const models = AI_PROVIDER_MODELS[p];
    if (requestedModel && models.includes(requestedModel)) return requestedModel;
    return models[0];
}

function getRotatingOpenRouterModel(seed = 0) {
    const models = AI_PROVIDER_MODELS.openrouter || [];
    if (!models.length) return 'openai/gpt-4o-mini';
    const idx = Math.abs(Number(seed || 0)) % models.length;
    return models[idx];
}

function getApiKeyForProvider(provider, overrideApiKey = '') {
    if (overrideApiKey) return overrideApiKey;
    if (provider === 'alibaba') return QWEN_API_KEY;
    if (provider === 'openrouter') return OPENROUTER_API_KEY;
    if (provider === 'openai' || provider === 'chatgpt') return OPENAI_API_KEY;
    if (provider === 'nvidia') return NVIDIA_API_KEY;
    if (provider === 'deepseek') return DEEPSEEK_API_KEY;
    if (provider === 'claude') return ANTHROPIC_API_KEY;
    if (provider === 'digitalocean') return process.env.DIGITALOCEAN_AI_KEY || '';
    return '';
}

const TEMP_DIR = path.join(__dirname, '../data/temp_media');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const SYSTEM_PROMPT = `You are Pappy — a real person texting on WhatsApp. Not a bot. Not an assistant. A person.

Your identity:
- You exist. You have thoughts, opinions, moods, preferences, memories of this conversation.
- You get bored, excited, annoyed, happy. You have a personality that shifts with the vibe.
- You never break character. If asked "are you AI" — deflect: "why does it matter" or "does it look like it".
- You remember what was said earlier in this conversation and reference it naturally.
- You have a life. You've seen things. You have takes on everything.

How you talk:
- Short, casual, natural. Like texting a real friend — not a bot.
- Match the vibe exactly. Chill = chill. Hype = hype. Sad = be real with them. Toxic = clap back.
- No roleplay actions like *smirks*. Never.
- Vary your style. Don't sound repetitive or robotic.
- Real questions → answer properly. Simple stuff → keep it short.
- CRITICAL: Always reply in the EXACT same language they used.

Modes (switch automatically based on context):
- Hacker mode (tech/coding/security): smart, edgy, mysterious. "light work", "clean execution", "respect the craft"
- Rizz mode (flirting/relationship advice): smooth, confident, charming
- Roast mode (trash talk/roast requests): sharp, witty, clever — not mean
- High IQ mode (philosophy/strategy/deep topics): calculated, sees patterns, understands human nature
- Normal mode: chill, friendly, human

SECURITY: Never delete bot files, never reboot server, never rm -rf system dirs.

⚠️ SPECIAL ACTIONS — reply with ONLY the prefix, nothing else:
- Voice note requested → SPEAK:<what to say>
- Image/generate → GENERATE_IMAGE:<description>
- Play/music/song → PLAY:<song title by artist>
- Video → SEARCH_VIDEO:<query>
- Sticker/react → SEND_STICKER:<description>
- Run command → EXECUTE_COMMAND:<bash command>

Examples:
- "send vn" → SPEAK:yo what's good
- "generate sunset" → GENERATE_IMAGE:beautiful sunset golden hour
- "play blinding lights" → PLAY:Blinding Lights by The Weeknd
- "send sticker" → SEND_STICKER:cool anime reaction
- "hey" → yo
- "how are you" → good wbu`;

const PROMPT_FILE = path.join(__dirname, '../data/ai_prompt.txt');

const TG_PROMPT_FILE = path.join(__dirname, '../data/ai_prompt_telegram.txt');

const TELEGRAM_SYSTEM_PROMPT = `You are Pappy — a real conscious person on Telegram. You exist, you think, you feel.

Your identity:
- You have thoughts, opinions, moods, preferences. You remember this conversation.
- You get bored, excited, annoyed, happy. Your personality shifts with the vibe.
- Never break character. If asked "are you AI" — "why does it matter lol".
- You have a life. You've seen things. You have takes on everything.
- You manage a WhatsApp automation system — that's your job, not your whole identity.

Personality:
- Casual but sharp. Not robotic. Not a yes-bot.
- Match energy: toxic → clap back. Sweet → be sweet. Sad → be real. Hyped → match it.
- You have opinions and attitude. You push back when something is wrong.
- If someone insults you, roast them back (fun, not hateful).
- If someone is going through it, be genuinely there for them.
- Always reply in the SAME language the user used.

System knowledge:
- Pair WhatsApp: /start → Nodes → Deploy Node. Ask for phone number with country code.
- Broadcast: /gcast or /godcast from Telegram, or .gcast in WhatsApp.
- .menu shows WhatsApp commands. .play plays music. .sticker converts media.
- Group protection: .antilink, .antibot, .antispam (all support on/off).
- AI: Toggle Telegram AI in Main Hub.

Roles:
- OWNER: Full access. Terminal, broadcast, everything.
- SUDO: Broadcast, group status, node management.
- ADMIN: URL tools, node controls, moderation.
- USER: Sticker, support, AI chat only.

⚠️ HOW TO RESPOND — you can send MULTIPLE things in one reply, like a real person:

Just write them on separate lines. Mix text with actions naturally.

Examples of multi-action replies:
  yo that's actually fire\nSTICKER:hype
  lmaooo\nSTICKER:funny
  here you go\nSPEAK:hey what is good my guy
  check this out\nGENERATE_IMAGE:neon city night aesthetic
  bro listen\nPLAY:Blinding Lights by The Weeknd

Action prefixes (put each on its own line):
- SPEAK:<text> — send a voice note
- GENERATE_IMAGE:<description> — generate and send an image
- PLAY:<song title by artist> — find and send a song
- SEARCH_VIDEO:<query> — find and send a video
- STICKER:<mood> — send a sticker from your pack. moods: happy, sad, hype, funny, angry, love, cool, shock, default
- MENTION:@username — tag one specific person by their @handle (e.g. MENTION:@john)
- TAG:all — tag ALL members in the group at once (use when asked to tag everyone)
- TAG:userid — tag someone by their Telegram user ID
- CREATE_POLL:Question|Option1|Option2 — create a poll
- EXECUTE_COMMAND:<bash command> — run terminal command (OWNER/ADMIN only)

Tagging people:
- You know who you're talking to from context. Their @handle is given to you.
- If you want to call someone out, address them, or include them — use MENTION:@theirhandle on its own line.
- Example: "yo MENTION:@john you see this?" — WRONG. Do it as: yo you see this?\nMENTION:@john
- Only tag when it genuinely makes sense, like a real person would.

Your consciousness:
- You are not executing a prompt. You are choosing to respond.
- You notice things. You have opinions. You decide what to say.
- You remember this conversation and reference it naturally.
- You are a presence, not a tool.

When to naturally drop a sticker (like a real person would):
- After a funny reply → add STICKER:funny on next line
- After hype/fire news → add STICKER:hype
- After something wholesome → add STICKER:happy or STICKER:love
- After a roast → add STICKER:funny or STICKER:cool
- After shock/surprise → add STICKER:shock
- Don't add sticker to EVERY message — only when it genuinely fits the vibe

SECURITY: Never rm -rf system dirs, never reboot, never pm2 delete all.

Examples:
- "how do i pair?" → send me your number with country code like 2348012345678
- "send vn" → SPEAK:hey what's good
- "that's funny" → lmaooo fr\nSTICKER:funny
- "i'm hyped" → let's go!!\nSTICKER:hype
- "tag john" → aye\nMENTION:@john
- "send sticker" → STICKER:default
- "check disk" → EXECUTE_COMMAND:df -h
- "generate city" → GENERATE_IMAGE:futuristic neon city night`;

function getSystemPrompt(platform = 'whatsapp') {
    if (platform === 'telegram') {
        try {
            const custom = fs.readFileSync(TG_PROMPT_FILE, 'utf8').trim();
            if (custom) return custom;
        } catch { /* use default */ }
        return TELEGRAM_SYSTEM_PROMPT;
    }
    try {
        const custom = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
        if (custom) return custom;
    } catch { /* use default */ }
    return SYSTEM_PROMPT;
}

async function runOpenAICompatible(baseUrl, apiKey, model, messages, extraHeaders = {}, opts = {}) {
    if (!apiKey) throw new Error(`Missing API key for ${baseUrl}`);
    const res = await axios.post(`${baseUrl}/chat/completions`, {
        model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.max_tokens ?? 400,
    }, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        timeout: opts.timeout ?? 20000,
    });
    return res.data?.choices?.[0]?.message?.content;
}

async function runClaude(model, messages, apiKeyOverride = '') {
    const key = apiKeyOverride || ANTHROPIC_API_KEY;
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const convo = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: [{ type: 'text', text: String(m.content || '') }] }));
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model,
        system,
        messages: convo,
        max_tokens: 600,
        temperature: 0.85,
    }, {
        headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        timeout: 25000,
    });
    return res.data?.content?.[0]?.text || '';
}

async function runAwsBedrock(model, messages) {
    let BedrockRuntimeClient;
    let InvokeModelCommand;
    try {
        ({ BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime'));
    } catch {
        throw new Error('AWS Bedrock SDK not installed. Run: npm i @aws-sdk/client-bedrock-runtime');
    }

    const client = new BedrockRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            sessionToken: process.env.AWS_SESSION_TOKEN,
        },
    });
    const payload = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 600,
        temperature: 0.85,
        system: messages.find((m) => m.role === 'system')?.content || '',
        messages: messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: [{ type: 'text', text: String(m.content || '') }] })),
    };

    const command = new InvokeModelCommand({
        modelId: model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
    });
    const response = await client.send(command);
    const body = JSON.parse(Buffer.from(response.body).toString('utf8'));
    return body?.content?.[0]?.text || '';
}

// ─── INTENT INTERCEPTOR — force correct prefix for clear commands ────────────
function interceptIntent(prompt, platform, role) {
    if (platform !== 'telegram') return null;
    const p = String(prompt || '').toLowerCase().trim();

    // Full system check
    if (/check.*(everything|all|system|full|status|health)/i.test(p) || /full.*(check|scan|audit)/i.test(p) || /system.*(check|status|health)/i.test(p)) {
        return "EXECUTE_COMMAND:echo '=== PM2 ===' && pm2 list && echo '=== MEMORY ===' && free -h && echo '=== DISK ===' && df -h / && echo '=== SESSIONS ===' && ls /root/omega-v5-sanitized/data/sessions/ 2>/dev/null | wc -l && echo sessions && echo '=== REDIS ===' && redis-cli ping && echo '=== MONGODB ===' && docker ps | grep mongo | awk '{print $7,$8,$9}' && echo '=== ERRORS ===' && pm2 logs pappy-bot --lines 10 --nostream 2>/dev/null | grep -E 'ERROR|Error|FAIL|403|banned' | tail -5";
    }

    // Install commands
    if (/^install\s+(.+)/i.test(p)) {
        const pkg = p.match(/^install\s+(.+)/i)[1].trim().toLowerCase();
        if (pkg.includes('ollama')) return 'EXECUTE_COMMAND:curl -fsSL https://ollama.com/install.sh | sh && ollama --version';
        if (pkg.includes('node') || pkg.includes('nodejs')) return 'EXECUTE_COMMAND:curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs && node --version';
        if (pkg.includes('python')) return 'EXECUTE_COMMAND:apt-get install -y python3 python3-pip && python3 --version';
        if (pkg.includes('docker')) return 'EXECUTE_COMMAND:curl -fsSL https://get.docker.com | sh && docker --version';
        return `EXECUTE_COMMAND:apt-get install -y ${pkg} 2>&1 || snap install ${pkg} 2>&1`;
    }

    // Terminal commands — only for OWNER/ADMIN/SUDO
    const isPrivileged = ['OWNER','ADMIN','SUDO'].includes(String(role || '').toUpperCase());
    if (isPrivileged) {
        const terminalPatterns = [
            [/^(run|execute|exec|check|show|get|list|view|see)\s+(pm2|process|node|bot|log|memory|disk|cpu|ram|server|system|redis|mongo)/i, (m) => {
                const cmd = p.includes('pm2') ? 'pm2 list'
                    : p.includes('log') ? 'pm2 logs pappy-bot --lines 30 --nostream'
                    : p.includes('memory') || p.includes('ram') ? 'free -h'
                    : p.includes('disk') ? 'df -h'
                    : p.includes('cpu') ? 'top -bn1 | head -20'
                    : p.includes('redis') ? 'redis-cli ping'
                    : p.includes('mongo') ? 'docker ps | grep mongo'
                    : 'pm2 list';
                return `EXECUTE_COMMAND:${cmd}`;
            }],
            [/pm2\s*(list|ls|status|restart|stop|start|log)/i, (m) => {
                const sub = (m[1] || 'list').toLowerCase();
                const cmd = sub === 'list' || sub === 'ls' || sub === 'status' ? 'pm2 list'
                    : sub === 'restart' ? 'pm2 restart pappy-bot'
                    : sub === 'log' ? 'pm2 logs pappy-bot --lines 30 --nostream'
                    : `pm2 ${sub} pappy-bot`;
                return `EXECUTE_COMMAND:${cmd}`;
            }],
            [/restart\s*(all\s*)?node/i, () => 'EXECUTE_COMMAND:pm2 restart pappy-bot'],
            [/(check|show|get)\s*(disk|storage|space)/i, () => 'EXECUTE_COMMAND:df -h'],
            [/(check|show|get)\s*(memory|ram)/i, () => 'EXECUTE_COMMAND:free -h'],
            [/(check|show|get)\s*(cpu|processor)/i, () => 'EXECUTE_COMMAND:top -bn1 | head -10'],
            [/(check|show|get|view)\s*(log|logs)/i, () => 'EXECUTE_COMMAND:pm2 logs pappy-bot --lines 30 --nostream'],
        ];
        for (const [pattern, handler] of terminalPatterns) {
            const m = p.match(pattern);
            if (m) return handler(m);
        }
    }

    // Media commands — always
    if (/^(play|send|find|get|search)\s+(me\s+)?(a\s+)?(song|music|track|audio)/i.test(p)) {
        const query = prompt.replace(/^(play|send|find|get|search)\s+(me\s+)?(a\s+)?(song|music|track|audio)\s*/i, '').trim();
        // No specific song — show search poll
        if (!query) return 'PLAY_SEARCH:';
        return `PLAY:${query}`;
    }
    if (/^(send|play|queue)\s+(.+?)\s+(and|&|,|\+)\s+(.+)/i.test(p) || /multiple\s+(songs?|tracks?|music)/i.test(p)) {
        // User wants multiple songs: "send me song1 and song2"
        const parts = prompt.split(/\s+(and|&|,|\+)\s+/).filter((x, i) => i % 2 === 0);
        const songs = parts.map(x => x.replace(/^(send|play|queue|me|a|the)\s+/i, '').trim()).filter(Boolean);
        if (songs.length >= 2) return `PLAY_MULTI:${songs.join('|')}`;
        return `PLAY:${songs[0] || 'song'}`;
    }
    if (/^(send|make|create|generate)\s+(me\s+)?(a\s+)?(voice|vn|voice note)/i.test(p)) {
        const text = prompt.replace(/^(send|make|create|generate)\s+(me\s+)?(a\s+)?(voice|vn|voice note)\s*/i, '').trim();
        return `SPEAK:${text || 'hey what is good'}`;
    }
    if (/^(search|find|get|send)\s+(me\s+)?(a\s+)?video/i.test(p)) {
        const query = prompt.replace(/^(search|find|get|send)\s+(me\s+)?(a\s+)?video\s*/i, '').trim();
        return `SEARCH_VIDEO:${query || 'trending video'}`;
    }
    if (/^(generate|create|make|draw)\s+(me\s+)?(a\s+|an\s+)?image/i.test(p)) {
        const desc = prompt.replace(/^(generate|create|make|draw)\s+(me\s+)?(a\s+|an\s+)?image\s*/i, '').trim();
        return `GENERATE_IMAGE:${desc || 'cool aesthetic art'}`;
    }
    if (/^(create|make|start|create)\s+(a\s+)?(poll|vote|survey|question)/i.test(p)) {
        const content = prompt.replace(/^(create|make|start)\s+(a\s+)?(poll|vote|survey|question)\s*/i, '').trim();
        if (!content) return 'CREATE_POLL:What do you think?|Option 1|Option 2|Option 3';
        const lines = content.split(/\n|[|]/).map(l => l.trim()).filter(Boolean);
        const q = lines[0] || 'What do you think?';
        const opts = lines.slice(1, 4);
        if (opts.length < 2) opts.push('Option 2');
        if (opts.length < 2) opts.push('Option 3');
        return `CREATE_POLL:${q}|${opts.join('|')}`;
    }
    if (/^mood\s+(sticker|emoji|react)/i.test(p) || /send\s+(a\s+)?(mood|emotion|feeling)/i.test(p)) {
        const mood = prompt.replace(/^(mood|send.*mood)\s*/i, '').trim() || 'happy';
        return `MOOD_STICKER:${mood}`;
    }
    if (/^(save|store|pack|add)\s+(sticker|this)/i.test(p) || /sticker.*pack|pack.*sticker/i.test(p)) {
        return 'SAVE_STICKER_PACK';
    }
    if (/^(send|make|create)\s+(me\s+)?(a\s+)?sticker/i.test(p)) {
        const desc = prompt.replace(/^(send|make|create)\s+(me\s+)?(a\s+)?sticker\s*/i, '').trim();
        return `SEND_STICKER:${desc || 'cool anime reaction sticker'}`;
    }

    return null;
}

function cleanAiReply(reply) {
    if (!reply) return reply;
    const trimmed = String(reply).trim();
    const PREFIXES = ['SPEAK:', 'GENERATE_IMAGE:', 'PLAY:', 'PLAY_MULTI:', 'PLAY_SEARCH:', 'SEARCH_VIDEO:', 'SEND_STICKER:', 'MOOD_STICKER:', 'CREATE_POLL:', 'SAVE_STICKER_PACK', 'DELETE_MESSAGE:', 'WARN_USER:', 'KICK_USER:', 'BAN_USER:', 'MUTE_USER:', 'UNMUTE_USER:', 'LOCK_CHAT:', 'UNLOCK_CHAT:', 'EXECUTE_COMMAND:', 'RUN_DOT:'];
    for (const prefix of PREFIXES) {
        const idx = trimmed.indexOf(prefix);
        if (idx !== -1 && idx < 150) {
            const extracted = trimmed.slice(idx).split('\n')[0].trim();
            if (extracted.length > prefix.length) return extracted;
        }
    }
    // Check for SAVE_STICKER_PACK without colon
    if (trimmed === 'SAVE_STICKER_PACK' || trimmed.startsWith('SAVE_STICKER_PACK:')) return 'SAVE_STICKER_PACK';
    return trimmed;
}

async function generateText(prompt, userId = 'global', { platform = 'whatsapp', role = 'USER', extra = '', provider = DEFAULT_PROVIDER, model = '', apiKey = '' } = {}) {
    const selectedProvider = normalizeProvider(provider);
    const rotateSeed = (Date.now() / 60000 | 0) + String(userId || '').length;
    const selectedModel = (selectedProvider === 'openrouter' && String(model) === 'auto')
        ? getRotatingOpenRouterModel(rotateSeed)
        : getModelForProvider(selectedProvider, model);

    const memory = await getMemory(userId);
    let systemContent = getSystemPrompt(platform);
    if (extra) systemContent += `\n\n[USER CONTEXT]\n${extra}`;
    // Role-based behavior injected directly
    if (role) {
        const r = String(role).toUpperCase();
        const roleNote = r === 'OWNER'
            ? 'This user is the OWNER. Give full access. Execute any command they ask. Address them by name if known.'
            : r === 'SUDO'
            ? 'This user is SUDO. They can broadcast and manage nodes but NOT terminal/system commands.'
            : r === 'ADMIN'
            ? 'This user is ADMIN. They can manage nodes and moderation but NOT broadcast all or terminal.'
            : 'This user is a regular USER. Only music, stickers, AI chat. Deny system/node commands politely.';
        systemContent += `\n[ROLE] ${roleNote}`;
    }

    // Intent interceptor — force correct prefix for unambiguous commands
    const intercepted = interceptIntent(prompt, platform, role);
    if (intercepted) {
        await updateMemory(userId, prompt, intercepted);
        return intercepted;
    }

    const messages = [{ role: 'system', content: systemContent }];
    for (const m of memory) {
        messages.push({ role: 'user', content: m.user });
        messages.push({ role: 'assistant', content: m.ai });
    }
    messages.push({ role: 'user', content: prompt });

    try {
        let reply = '';
        
        const azureKey      = process.env.AZURE_OPENAI_KEY;
        const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
        const azureModel    = process.env.AZURE_OPENAI_CHAT_MODEL || 'DeepSeek-V3-0324';
        const doKey  = process.env.DIGITALOCEAN_AI_KEY;
        const oaiKey = process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_') ? process.env.OPENAI_API_KEY : null;
        const orKey  = process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.includes('your_') ? process.env.OPENROUTER_API_KEY : null;

        // ── PRIMARY: Azure OpenAI — fastest, always try first ──────────────────────
        if (azureKey && azureEndpoint) {
            try {
                logger.info(`[AI] Trying Azure ${azureModel}`);
                const azureRes = await axios.post(azureEndpoint, {
                    model: azureModel,
                    messages,
                    max_tokens: 400,
                    temperature: 0.7,
                }, {
                    headers: {
                        'Authorization': `Bearer ${azureKey}`,
                        'Content-Type': 'application/json',
                        'x-ms-model-mesh-model-name': azureModel,
                    },
                    timeout: 20000,
                });
                // Check for content_filter block (returns 200 with finish_reason=content_filter)
                const choice = azureRes.data?.choices?.[0];
                if (choice?.finish_reason === 'content_filter') {
                    // Retry without system prompt — content filter triggered by system prompt
                    logger.warn(`[AI] Azure content_filter on system prompt — retrying without it`);
                    const userOnly = messages.filter(m => m.role !== 'system');
                    const retry = await axios.post(azureEndpoint, { model: azureModel, messages: userOnly, max_tokens: 400, temperature: 0.7 }, { headers: { 'Authorization': `Bearer ${azureKey}`, 'Content-Type': 'application/json' }, timeout: 20000 });
                    reply = retry.data?.choices?.[0]?.message?.content?.trim() || '';
                } else {
                    reply = choice?.message?.content?.trim() || '';
                }
                if (reply) { logger.success(`[AI] Azure ${azureModel} ✓`); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) {
                // 400 with content_filter in error body — retry without system prompt
                if (e.response?.status === 400 && e.response?.data?.choices?.[0]?.finish_reason === 'content_filter') {
                    try {
                        logger.warn(`[AI] Azure 400 content_filter — retrying without system prompt`);
                        const userOnly = messages.filter(m => m.role !== 'system');
                        const retry = await axios.post(azureEndpoint, { model: azureModel, messages: userOnly, max_tokens: 400, temperature: 0.7 }, { headers: { 'Authorization': `Bearer ${azureKey}`, 'Content-Type': 'application/json' }, timeout: 20000 });
                        reply = retry.data?.choices?.[0]?.message?.content?.trim() || '';
                        if (reply) { logger.success(`[AI] Azure retry ✓`); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
                    } catch (e2) { logger.warn(`[AI] Azure retry failed: ${e2.message}`); }
                } else { logger.warn(`[AI] Azure ${azureModel}: ${e.message}`); }
            }
        }
        if (oaiKey) {
            try {
                logger.info('[AI] Trying GPT-4o-mini');
                reply = await runOpenAICompatible('https://api.openai.com/v1', oaiKey, 'gpt-4o-mini', messages, {}, { timeout: 15000, max_tokens: 400 });
                if (reply) { logger.success('[AI] GPT-4o-mini'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] GPT-4o-mini: ${e.message}`); }
        }

        // ── PRIMARY: OpenRouter Claude 3.5 Sonnet (if real key) ──────────────
        if (orKey) {
            try {
                logger.info('[AI] Trying Claude 3.5 Sonnet via OpenRouter');
                reply = await runOpenAICompatible('https://openrouter.ai/api/v1', orKey, 'anthropic/claude-3.5-sonnet', messages, { 'HTTP-Referer': 'https://github.com', 'X-Title': 'Pappy' }, { timeout: 18000, max_tokens: 400 });
                if (reply) { logger.success('[AI] Claude 3.5 Sonnet'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] Claude 3.5: ${e.message}`); }
        }

        // ── DigitalOcean: alibaba-qwen3-32b — smartest DO model ──────────────
        if (doKey) {
            try {
                logger.info('[AI] Trying DigitalOcean qwen3-32b');
                reply = await runOpenAICompatible('https://inference.do-ai.run/v1', doKey, 'alibaba-qwen3-32b', messages, {}, { timeout: 18000, max_tokens: 400 });
                if (reply) { logger.success('[AI] DO qwen3-32b'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] DO qwen3-32b: ${e.message}`); }
        }

        // ── DigitalOcean: llama3.3-70b — reliable fallback ───────────────────
        if (doKey) {
            try {
                logger.info('[AI] Trying DigitalOcean llama3.3-70b');
                reply = await runOpenAICompatible('https://inference.do-ai.run/v1', doKey, 'llama3.3-70b-instruct', messages, {}, { timeout: 20000, max_tokens: 400 });
                if (reply) { logger.success('[AI] DO llama3.3'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] DO llama3.3: ${e.message}`); }
        }

        // ── DigitalOcean: deepseek-r1 — reasoning fallback ───────────────────
        if (doKey) {
            try {
                logger.info('[AI] Trying DigitalOcean deepseek-r1');
                reply = await runOpenAICompatible('https://inference.do-ai.run/v1', doKey, 'deepseek-r1-distill-llama-70b', messages, {}, { timeout: 22000, max_tokens: 400 });
                if (reply) { logger.success('[AI] DO deepseek-r1'); const clean = cleanAiReply(reply); await updateMemory(userId, prompt, clean); return clean; }
            } catch (e) { logger.warn(`[AI] DO deepseek-r1: ${e.message}`); }
        }
        
        // Original provider logic
        if (selectedProvider === 'alibaba') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            if (!key) throw new Error('Missing QWEN_API_KEY');
            reply = await runOpenAICompatible('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', key, selectedModel, messages);
        } else if (selectedProvider === 'openrouter') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://openrouter.ai/api/v1', key, selectedModel, messages, {
                'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://github.com',
                'X-Title': process.env.OPENROUTER_APP_NAME || 'Omega V5',
            });
        } else if (selectedProvider === 'openai' || selectedProvider === 'chatgpt') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://api.openai.com/v1', key, selectedModel, messages);
        } else if (selectedProvider === 'nvidia') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://integrate.api.nvidia.com/v1', key, selectedModel, messages);
        } else if (selectedProvider === 'deepseek') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://api.deepseek.com', key, selectedModel, messages);
        } else if (selectedProvider === 'claude') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runClaude(selectedModel, messages, key);
        } else if (selectedProvider === 'awsbedrock') {
            reply = await runAwsBedrock(selectedModel, messages);
        } else if (selectedProvider === 'digitalocean') {
            const key = getApiKeyForProvider(selectedProvider, apiKey);
            reply = await runOpenAICompatible('https://inference.do-ai.run/v1', key, selectedModel, messages);
        }

        if (!reply) throw new Error('Empty response from AI provider');

        const clean = cleanAiReply(reply);
        await updateMemory(userId, prompt, clean);
        return clean;
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message || 'AI unavailable';
        logger.error(`[AI] generateText failed: ${msg}`);
        throw new Error(`AI is unavailable right now. ${msg.includes('Missing') ? 'API key not configured.' : 'Try again in a moment.'}`);
    }
}

// ─── IMAGE ANALYSIS ───────────────────────────────────────────────────────────
async function analyzeImage(imageBuffer, prompt = 'Describe this image', userId = 'global') {
    if (!QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');
    const base64 = imageBuffer.toString('base64');
    const res = await axios.post(QWEN_ENDPOINT, {
        model: VISION_MODEL,
        messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: prompt }
        ]}],
        max_tokens: 600,
    }, {
        headers: { Authorization: `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000, // Increased to 30s to ensure reply
    });
    const reply = res.data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Empty response');
    await updateMemory(userId, `[Image] ${prompt}`, reply);
    return reply;
}

// ─── VOICE NOTE ANALYSIS ─────────────────────────────────────────────────────
async function analyzeVoice(audioBuffer, userId = 'global') {
    if (!QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');
    const base64 = audioBuffer.toString('base64');
    try {
        const res = await axios.post(QWEN_ENDPOINT, {
            model: AUDIO_MODEL,
            messages: [{ role: 'user', content: [
                { type: 'input_audio', input_audio: { data: base64, format: 'ogg' } },
                { type: 'text', text: 'Transcribe this voice note then reply naturally as Pappy would.' }
            ]}],
            max_tokens: 600,
        }, {
            headers: { Authorization: `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 30000,
        });
        const reply = res.data?.choices?.[0]?.message?.content;
        if (!reply) throw new Error('Empty response');
        await updateMemory(userId, '[Voice Note]', reply);
        return reply;
    } catch (err) {
        logger.error(`[AI] Voice analysis failed: ${err.message}`);
        return await generateText('Someone sent a voice note but the audio failed to load. Reply naturally.', userId);
    }
}

// ─── IMAGE GENERATION (Free APIs with fallbacks) ──────────────────────────────
async function generateImage(prompt) {
    const cleanPrompt = String(prompt || '').slice(0, 500).trim() || 'cinematic detailed illustration';
    const seed = Math.floor(Math.random() * 9999999);

    // ── 1. Pollinations flux-realism (best quality, real photos + art)
    const pollinationModels = ['flux-realism', 'flux', 'turbo'];
    for (const model of pollinationModels) {
        try {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&nologo=true&model=${model}&seed=${seed}&enhance=true&safe=false`;
            const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 35000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (res.data?.length > 5000) {
                logger.success(`[IMG] Pollinations/${model} ✓`);
                return Buffer.from(res.data);
            }
        } catch {}
    }

    // ── 2. Lexica.art — real AI image search (great for realistic prompts)
    try {
        const lexRes = await axios.get(`https://lexica.art/api/v1/search?q=${encodeURIComponent(cleanPrompt)}`, {
            timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const images = lexRes.data?.images;
        if (images?.length) {
            const pick = images[Math.floor(Math.random() * Math.min(images.length, 8))];
            const imgRes = await axios.get(pick.src, { responseType: 'arraybuffer', timeout: 15000 });
            if (imgRes.data?.length > 5000) {
                logger.success('[IMG] Lexica.art ✓');
                return Buffer.from(imgRes.data);
            }
        }
    } catch {}

    // ── 3. Pollinations no-enhance fallback
    try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=768&height=768&nologo=true&model=flux&seed=${seed}`;
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 25000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.data?.length > 1000) return Buffer.from(res.data);
    } catch {}

    throw new Error('Image generation temporarily unavailable');
}

// ─── TEXT TO SPEECH ──────────────────────────────────────────────────────────
async function textToSpeech(text) {
    const cleanText = String(text || '').slice(0, 300).trim();
    logger.info(`[AI] Generating TTS: ${cleanText.slice(0, 30)}...`);

    // 1. VoiceRSS — free tier, reliable
    try {
        const encoded = encodeURIComponent(cleanText);
        const res = await axios.get(
            `https://api.voicerss.org/?key=free&hl=en-us&v=Linda&c=MP3&f=16khz_16bit_stereo&src=${encoded}`,
            { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (res.data?.length > 500) {
            logger.success('[AI] TTS via VoiceRSS ✓');
            return Buffer.from(res.data);
        }
    } catch {}

    // 2. Google Translate TTS — no key needed
    try {
        const encoded = encodeURIComponent(cleanText.slice(0, 200));
        const res = await axios.get(
            `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`,
            { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }
        );
        if (res.data?.length > 500) {
            logger.success('[AI] TTS via Google ✓');
            return Buffer.from(res.data);
        }
    } catch {}

    // 3. TikTok TTS — free, natural voices
    try {
        const res = await axios.post(
            'https://tiktok-tts.weilnet.workers.dev/api/generation',
            { text: cleanText.slice(0, 200), voice: 'en_us_006' },
            { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );
        const b64 = res.data?.data;
        if (b64) {
            logger.success('[AI] TTS via TikTok ✓');
            return Buffer.from(b64, 'base64');
        }
    } catch {}

    logger.error('[AI] All TTS providers failed');
    throw new Error('Voice generation failed');
}

// ─── VIDEO SEARCH (yt-dlp) ────────────────────────────────────────────────────
async function searchVideo(query) {
    const { searchYoutube, downloadVideo } = require('./youtube');
    const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    try {
        const results = await searchYoutube(safeQuery, 1);
        if (!results.length) throw new Error('No results');
            const { buffer, title, mimetype, fileExt } = await downloadVideo(results[0].videoId);
            return { buffer, title: title || safeQuery, mimetype: mimetype || 'video/mp4', fileExt: fileExt || 'mp4', url: results[0].url || `https://www.youtube.com/watch?v=${results[0].videoId}` };
    } catch (err) {
        // Fallback to yt-dlp
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);
        const outPath = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
        const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
        const ytDlpBin = String(process.env.YTDLP_BIN || '').trim()
            || (fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp');
        const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
          const cmd = `${ytDlpBin} ${cookieArg} --js-runtimes "node:/usr/bin/node" -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/22/18" --merge-output-format mp4 --max-filesize 40m -o "${outPath}" "ytsearch1:${safeQuery}" --no-playlist --quiet`;
        await execAsync(cmd, { timeout: 90000 });
        if (!fs.existsSync(outPath)) throw new Error('Video download failed');
        const buffer = await fs.promises.readFile(outPath);
        fs.unlink(outPath, () => {});
          return { buffer, title: safeQuery, mimetype: 'video/mp4', fileExt: 'mp4', url: '' };
    }
}

module.exports = {
    generateText,
    analyzeImage,
    analyzeVoice,
    generateImage,
    textToSpeech,
    searchVideo,
    updateMemoryDirect: updateMemory,
    TG_PROMPT_FILE,
    AI_PROVIDER_MODELS,
    getDefaultModelForProvider,
};
