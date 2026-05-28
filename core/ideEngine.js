// core/ideEngine.js
// 🧠 FULL IDE AI ENGINE — Persistent sessions, file ops, project building, chained suggestions
'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { updateMemory } = require('./ai.memory');
const logger = require('./logger');

// ── Active IDE sessions per user ──────────────────────────────────────────
// userId -> { cwd, history, runningProc, files, projectName }
const ideSessions = new Map();

function getSession(userId) {
    if (!ideSessions.has(userId)) {
        ideSessions.set(userId, {
            cwd: '/root',
            history: [],       // [{role, content}] full conversation
            runningProc: null,
            files: new Map(),  // path -> content (in-memory edits)
            projectName: null,
            lastOutput: '',
            lastCommand: '',
            iteration: 0,      // how many times we've chained
        });
    }
    return ideSessions.get(userId);
}

function clearSession(userId) {
    ideSessions.delete(userId);
}

// ── Execute command with live streaming ───────────────────────────────────
async function execLive(command, cwd, onData, timeoutMs = 60000) {
    return new Promise((resolve) => {
        let output = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGTERM');
        }, timeoutMs);

        const proc = spawn('bash', ['-c', command], { cwd, timeout: timeoutMs });

        proc.stdout.on('data', (d) => {
            const chunk = d.toString();
            output += chunk;
            if (onData) onData(chunk, output);
        });
        proc.stderr.on('data', (d) => {
            const chunk = d.toString();
            output += chunk;
            if (onData) onData(chunk, output);
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({ output, code, timedOut });
        });
        proc.on('error', (e) => {
            clearTimeout(timer);
            resolve({ output: `Error: ${e.message}`, code: -1, timedOut: false });
        });

        return proc;
    });
}

// ── Parse AI IDE response into structured actions ─────────────────────────
function parseIdeResponse(text) {
    const actions = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();

        // RUN: command
        if (line.startsWith('RUN:')) {
            actions.push({ type: 'run', command: line.slice(4).trim() });
            i++;
            continue;
        }

        // WRITE_FILE: path
        // ```
        // content
        // ```
        if (line.startsWith('WRITE_FILE:')) {
            const filePath = line.slice(11).trim();
            i++;
            let content = '';
            // skip opening ```
            if (lines[i] && lines[i].trim().startsWith('```')) i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                content += lines[i] + '\n';
                i++;
            }
            if (lines[i] && lines[i].trim().startsWith('```')) i++;
            actions.push({ type: 'write', path: filePath, content });
            continue;
        }

        // READ_FILE: path
        if (line.startsWith('READ_FILE:')) {
            actions.push({ type: 'read', path: line.slice(10).trim() });
            i++;
            continue;
        }

        // DELETE_FILE: path
        if (line.startsWith('DELETE_FILE:')) {
            actions.push({ type: 'delete', path: line.slice(12).trim() });
            i++;
            continue;
        }

        // MKDIR: path
        if (line.startsWith('MKDIR:')) {
            actions.push({ type: 'mkdir', path: line.slice(6).trim() });
            i++;
            continue;
        }

        // CD: path
        if (line.startsWith('CD:')) {
            actions.push({ type: 'cd', path: line.slice(3).trim() });
            i++;
            continue;
        }

        // SEND_FILE: path
        if (line.startsWith('SEND_FILE:')) {
            actions.push({ type: 'send_file', path: line.slice(10).trim() });
            i++;
            continue;
        }

        // SEND_FOLDER: path
        if (line.startsWith('SEND_FOLDER:')) {
            actions.push({ type: 'send_folder', path: line.slice(12).trim() });
            i++;
            continue;
        }

        // DONE: message — signals task complete
        if (line.startsWith('DONE:')) {
            actions.push({ type: 'done', message: line.slice(5).trim() });
            i++;
            continue;
        }

        // NEED_INPUT: question — asks user for input
        if (line.startsWith('NEED_INPUT:')) {
            actions.push({ type: 'need_input', question: line.slice(11).trim() });
            i++;
            continue;
        }

        // Plain text — show as message
        if (line && !line.startsWith('```')) {
            // Collect consecutive plain text lines
            let msg = '';
            while (i < lines.length) {
                const l = lines[i].trim();
                if (l.startsWith('RUN:') || l.startsWith('WRITE_FILE:') || l.startsWith('READ_FILE:') ||
                    l.startsWith('DELETE_FILE:') || l.startsWith('MKDIR:') || l.startsWith('CD:') ||
                    l.startsWith('SEND_FILE:') || l.startsWith('SEND_FOLDER:') || l.startsWith('DONE:') ||
                    l.startsWith('NEED_INPUT:')) break;
                msg += lines[i] + '\n';
                i++;
            }
            if (msg.trim()) actions.push({ type: 'message', text: msg.trim() });
            continue;
        }

        i++;
    }

    return actions;
}

// ── Build IDE system prompt ───────────────────────────────────────────────
function buildIdeSystemPrompt(session) {
    return `You are an elite IDE AI running on a live Linux VPS. You have FULL access to the filesystem and terminal.

Current directory: ${session.cwd}
Project: ${session.projectName || 'none'}

You can execute ANY task — install software, build projects, write code, fix bugs, deploy apps.
You work in ITERATIONS — you keep going until the task is FULLY complete. Never stop halfway.

RESPONSE FORMAT — use these exact prefixes:
- Plain text for explanations (brief)
- RUN:<bash command>          — execute a shell command
- WRITE_FILE:<path>           — write/create a file (follow with \`\`\` content \`\`\`)
- READ_FILE:<path>            — read a file
- DELETE_FILE:<path>          — delete a file
- MKDIR:<path>                — create directory
- CD:<path>                   — change working directory
- SEND_FILE:<path>            — send file to user in Telegram
- SEND_FOLDER:<path>          — zip and send folder to user
- DONE:<message>              — task is fully complete
- NEED_INPUT:<question>       — ask user for required info

RULES:
- Always RUN commands to verify things work — don't just write code and stop
- After writing code, RUN it to test
- If something fails, fix it and try again — keep iterating
- Install missing dependencies automatically
- Be concise in text — let actions speak
- NEVER give instructions — DO the work
- When task is done, say DONE:<summary>

Examples:
User: "install ollama"
You:
RUN:curl -fsSL https://ollama.com/install.sh | sh
RUN:ollama --version

User: "build a node.js hello world app"
You:
MKDIR:/root/hello-app
WRITE_FILE:/root/hello-app/index.js
\`\`\`
const http = require('http');
http.createServer((req,res) => res.end('Hello World')).listen(3000);
console.log('Running on port 3000');
\`\`\`
WRITE_FILE:/root/hello-app/package.json
\`\`\`
{"name":"hello-app","version":"1.0.0","main":"index.js"}
\`\`\`
CD:/root/hello-app
RUN:node index.js &
DONE:Hello World app running on port 3000`;
}

module.exports = {
    getSession,
    clearSession,
    execLive,
    parseIdeResponse,
    buildIdeSystemPrompt,
    ideSessions,
};
