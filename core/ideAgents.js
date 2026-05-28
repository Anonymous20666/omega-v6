// core/ideAgents.js
// 🧠 MULTI-AGENT IDE PIPELINE
// Planner → Coder → Executor → Reviewer → loop until done
'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const { updateMemory } = require('./ai.memory');
const logger = require('./logger');

// ── Agent prompts ─────────────────────────────────────────────────────────

const PLANNER_PROMPT = `You are the PLANNER agent in an IDE AI pipeline.

Your job: Take the user's request (however messy or vague) and produce a clear, structured execution plan.

Output format — ONLY this, nothing else:
GOAL: <one sentence what we're building/doing>
STEPS:
1. <concrete step>
2. <concrete step>
...
TECH: <languages/tools/packages needed>
CWD: <working directory, default /root>
RISKS: <potential issues to watch for>

Be specific. No fluff. The Coder agent will execute this plan exactly.`;

const CODER_PROMPT = `You are the CODER agent in an IDE AI pipeline.

You receive a plan and produce ONLY executable actions. No explanations unless critical.

AVAILABLE ACTIONS (use exactly):
RUN:<bash command>
WRITE_FILE:<absolute path>
\`\`\`
<file content>
\`\`\`
READ_FILE:<absolute path>
MKDIR:<absolute path>
CD:<absolute path>
DELETE_FILE:<absolute path>
SEND_FILE:<absolute path>
SEND_FOLDER:<absolute path>
INSTALL:<package name>
DONE:<what was accomplished>
NEED_INPUT:<question for user>

RULES:
- Always RUN to verify after writing code
- Install missing packages with INSTALL: before using them
- Use absolute paths always
- After each RUN, the Executor will give you the output — use it to decide next step
- Keep iterating until DONE
- Never hallucinate — only write what you'll actually execute`;

const REVIEWER_PROMPT = `You are the REVIEWER agent in an IDE AI pipeline.

You receive: the original plan, all actions taken, and their outputs.

Your job: Determine if the task is complete and correct.

Output ONLY one of:
PASS: <brief confirmation of what works>
FAIL: <what's wrong> | FIX: <specific fix needed>
PARTIAL: <what's done> | REMAINING: <what's left>

Be strict. If there are errors in output, say FAIL. If it works, say PASS.`;

// ── Run a single AI call ──────────────────────────────────────────────────
async function callAgent(systemPrompt, userMessage, apiConfig = {}) {
    const { provider = 'digitalocean', model, apiKey } = apiConfig;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
    ];

    // Try DigitalOcean first
    const doKey = process.env.DIGITALOCEAN_AI_KEY;
    if (doKey) {
        try {
            const res = await axios.post('https://api.digitalocean.com/v2/gen-ai/chat/completions', {
                model: model || 'llama3.3-70b-instruct',
                messages,
                temperature: 0.3, // low temp for precision
                max_tokens: 1500,
            }, {
                headers: { Authorization: `Bearer ${doKey}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            });
            return res.data?.choices?.[0]?.message?.content?.trim();
        } catch (e) { logger.warn(`[IDE Agent] DO failed: ${e.message}`); }
    }

    // Fallback to OpenRouter
    const orKey = process.env.OPENROUTER_API_KEY;
    if (orKey && !orKey.includes('your_')) {
        try {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: 'deepseek/deepseek-chat-v3-0324:free',
                messages,
                temperature: 0.3,
                max_tokens: 1500,
            }, {
                headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com' },
                timeout: 30000,
            });
            return res.data?.choices?.[0]?.message?.content?.trim();
        } catch (e) { logger.warn(`[IDE Agent] OR failed: ${e.message}`); }
    }

    throw new Error('No AI provider available');
}

// ── Execute a single action ───────────────────────────────────────────────
async function executeAction(action, session, onOutput) {
    const { type } = action;

    if (type === 'run') {
        const result = await new Promise((resolve) => {
            let out = '';
            const proc = spawn('bash', ['-c', action.command], { cwd: session.cwd, timeout: 60000 });
            proc.stdout.on('data', d => { out += d.toString(); if (onOutput) onOutput(d.toString()); });
            proc.stderr.on('data', d => { out += d.toString(); if (onOutput) onOutput(d.toString()); });
            proc.on('close', code => resolve({ out, code }));
            proc.on('error', e => resolve({ out: `Error: ${e.message}`, code: -1 }));
        });
        return { success: result.code === 0, output: result.out || '(no output)', code: result.code };
    }

    if (type === 'write') {
        try {
            fs.mkdirSync(path.dirname(action.path), { recursive: true });
            fs.writeFileSync(action.path, action.content, 'utf8');
            return { success: true, output: `✅ Written: ${action.path}` };
        } catch (e) { return { success: false, output: `❌ Write failed: ${e.message}` }; }
    }

    if (type === 'read') {
        try {
            const content = fs.readFileSync(action.path, 'utf8');
            return { success: true, output: content.slice(0, 3000) };
        } catch (e) { return { success: false, output: `❌ Read failed: ${e.message}` }; }
    }

    if (type === 'mkdir') {
        try {
            fs.mkdirSync(action.path, { recursive: true });
            return { success: true, output: `✅ Created: ${action.path}` };
        } catch (e) { return { success: false, output: `❌ mkdir failed: ${e.message}` }; }
    }

    if (type === 'cd') {
        if (fs.existsSync(action.path)) {
            session.cwd = action.path;
            return { success: true, output: `📁 Now in: ${action.path}` };
        }
        return { success: false, output: `❌ Directory not found: ${action.path}` };
    }

    if (type === 'delete') {
        try {
            fs.rmSync(action.path, { recursive: true, force: true });
            return { success: true, output: `🗑 Deleted: ${action.path}` };
        } catch (e) { return { success: false, output: `❌ Delete failed: ${e.message}` }; }
    }

    if (type === 'install') {
        const result = await new Promise((resolve) => {
            let out = '';
            const cmd = `apt-get install -y ${action.package} 2>&1 || npm install -g ${action.package} 2>&1 || pip3 install ${action.package} 2>&1`;
            const proc = spawn('bash', ['-c', cmd], { cwd: session.cwd, timeout: 120000 });
            proc.stdout.on('data', d => { out += d.toString(); if (onOutput) onOutput(d.toString()); });
            proc.stderr.on('data', d => { out += d.toString(); });
            proc.on('close', code => resolve({ out, code }));
            proc.on('error', e => resolve({ out: `Error: ${e.message}`, code: -1 }));
        });
        return { success: result.code === 0, output: result.out.slice(-500) };
    }

    if (type === 'send_file') {
        return { success: true, output: `SEND_FILE:${action.path}` };
    }

    if (type === 'send_folder') {
        return { success: true, output: `SEND_FOLDER:${action.path}` };
    }

    return { success: true, output: '' };
}

// ── Parse coder response into actions ─────────────────────────────────────
function parseCoderResponse(text) {
    const actions = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();

        if (line.startsWith('RUN:'))         { actions.push({ type: 'run',     command: line.slice(4).trim() }); i++; continue; }
        if (line.startsWith('MKDIR:'))       { actions.push({ type: 'mkdir',   path: line.slice(6).trim() }); i++; continue; }
        if (line.startsWith('CD:'))          { actions.push({ type: 'cd',      path: line.slice(3).trim() }); i++; continue; }
        if (line.startsWith('READ_FILE:'))   { actions.push({ type: 'read',    path: line.slice(10).trim() }); i++; continue; }
        if (line.startsWith('DELETE_FILE:')) { actions.push({ type: 'delete',  path: line.slice(12).trim() }); i++; continue; }
        if (line.startsWith('SEND_FILE:'))   { actions.push({ type: 'send_file',   path: line.slice(10).trim() }); i++; continue; }
        if (line.startsWith('SEND_FOLDER:')) { actions.push({ type: 'send_folder', path: line.slice(12).trim() }); i++; continue; }
        if (line.startsWith('INSTALL:'))     { actions.push({ type: 'install', package: line.slice(8).trim() }); i++; continue; }
        if (line.startsWith('DONE:'))        { actions.push({ type: 'done',    message: line.slice(5).trim() }); i++; continue; }
        if (line.startsWith('NEED_INPUT:'))  { actions.push({ type: 'need_input', question: line.slice(11).trim() }); i++; continue; }

        if (line.startsWith('WRITE_FILE:')) {
            const filePath = line.slice(11).trim();
            i++;
            let content = '';
            if (lines[i] && lines[i].trim().startsWith('```')) i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                content += lines[i] + '\n';
                i++;
            }
            if (lines[i] && lines[i].trim().startsWith('```')) i++;
            actions.push({ type: 'write', path: filePath, content });
            continue;
        }

        i++;
    }

    return actions;
}

// ── Main pipeline ─────────────────────────────────────────────────────────
async function runIdePipeline(userRequest, session, apiConfig, callbacks) {
    const { onPlanReady, onActionStart, onActionDone, onReview, onDone, onNeedInput, onSendFile } = callbacks;
    const MAX_ITERATIONS = 8;

    // ── STEP 1: PLANNER ───────────────────────────────────────────────────
    logger.info('[IDE] Planner running...');
    const plannerInput = `User request: ${userRequest}\nCurrent directory: ${session.cwd}`;
    const plan = await callAgent(PLANNER_PROMPT, plannerInput, apiConfig);
    if (!plan) throw new Error('Planner failed');

    session.currentPlan = plan;
    if (onPlanReady) await onPlanReady(plan);

    // ── STEP 2: CODER + EXECUTOR LOOP ────────────────────────────────────
    let coderInput = `PLAN:\n${plan}\n\nUser request: ${userRequest}\nCurrent directory: ${session.cwd}\n\nBegin execution.`;
    let allOutputs = '';
    let iteration = 0;
    let isDone = false;

    while (!isDone && iteration < MAX_ITERATIONS) {
        iteration++;
        logger.info(`[IDE] Coder iteration ${iteration}...`);

        const coderResponse = await callAgent(CODER_PROMPT, coderInput, apiConfig);
        if (!coderResponse) break;

        const actions = parseCoderResponse(coderResponse);
        if (!actions.length) break;

        let iterationOutput = '';

        for (const action of actions) {
            if (action.type === 'done') {
                isDone = true;
                if (onDone) await onDone(action.message, allOutputs);
                break;
            }

            if (action.type === 'need_input') {
                if (onNeedInput) await onNeedInput(action.question);
                return { status: 'waiting_input', plan };
            }

            if (onActionStart) await onActionStart(action);

            const result = await executeAction(action, session, (chunk) => {
                // live streaming callback
            });

            if (onActionDone) await onActionDone(action, result);

            // Handle file sends
            if (result.output?.startsWith('SEND_FILE:') || result.output?.startsWith('SEND_FOLDER:')) {
                if (onSendFile) await onSendFile(result.output);
            }

            iterationOutput += `\n[${action.type.toUpperCase()}] ${action.type === 'run' ? action.command : action.path || ''}\nOutput: ${result.output.slice(0, 500)}\n`;
            allOutputs += iterationOutput;
        }

        if (isDone) break;

        // Feed output back to coder for next iteration
        coderInput = `PLAN:\n${plan}\n\nPREVIOUS ACTIONS AND OUTPUTS:\n${allOutputs}\n\nCurrent directory: ${session.cwd}\n\nContinue. If task is complete, output DONE:<summary>. If you need to fix something, do it now.`;
    }

    // ── STEP 3: REVIEWER ─────────────────────────────────────────────────
    if (!isDone) {
        logger.info('[IDE] Reviewer running...');
        const reviewInput = `ORIGINAL PLAN:\n${plan}\n\nALL ACTIONS AND OUTPUTS:\n${allOutputs}`;
        const review = await callAgent(REVIEWER_PROMPT, reviewInput, apiConfig);
        if (onReview) await onReview(review, allOutputs);

        if (review?.startsWith('FAIL:')) {
            // Extract fix and do one more coder pass
            const fix = review.split('|')[1]?.replace('FIX:', '').trim();
            if (fix && iteration < MAX_ITERATIONS) {
                const fixInput = `PLAN:\n${plan}\n\nPREVIOUS OUTPUTS:\n${allOutputs}\n\nREVIEWER SAYS FIX: ${fix}\n\nApply the fix now.`;
                const fixResponse = await callAgent(CODER_PROMPT, fixInput, apiConfig);
                if (fixResponse) {
                    const fixActions = parseCoderResponse(fixResponse);
                    for (const action of fixActions) {
                        if (action.type === 'done') { isDone = true; if (onDone) await onDone(action.message, allOutputs); break; }
                        if (onActionStart) await onActionStart(action);
                        const result = await executeAction(action, session, null);
                        if (onActionDone) await onActionDone(action, result);
                        if (result.output?.startsWith('SEND_FILE:') || result.output?.startsWith('SEND_FOLDER:')) {
                            if (onSendFile) await onSendFile(result.output);
                        }
                    }
                }
            }
        }
    }

    // Save to memory
    await updateMemory(session.userId || 'global', userRequest, `Completed: ${session.currentPlan?.split('\n')[0] || 'task'}`).catch(() => {});

    return { status: 'done', plan, outputs: allOutputs };
}

module.exports = { runIdePipeline, callAgent, parseCoderResponse, executeAction };
