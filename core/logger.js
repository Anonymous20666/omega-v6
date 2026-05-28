// core/logger.js
'use strict';
const fs   = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../data/logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Auto-delete logs older than 1 day or larger than 10MB on startup
try {
    const cutoff  = Date.now() - 24 * 60 * 60 * 1000;
    const MAX_SIZE = 10 * 1024 * 1024;
    for (const f of fs.readdirSync(logDir)) {
        if (!f.startsWith('system-') || !f.endsWith('.log')) continue;
        const fp = path.join(logDir, f);
        try { const s = fs.statSync(fp); if (s.mtimeMs < cutoff || s.size > MAX_SIZE) fs.unlinkSync(fp); } catch {}
    }
} catch {}

const C = {
    reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
    red: '\x1b[31m', magenta: '\x1b[35m'
};

let _dateStr = new Date().toISOString().split('T')[0];
let _stream  = _createStream(_dateStr);

function _createStream(dateStr) {
    const s = fs.createWriteStream(path.join(logDir, `system-${dateStr}.log`), {
        flags: 'a', encoding: 'utf8', highWaterMark: 64 * 1024
    });
    s.on('error', () => {});
    return s;
}

function _write(level, message) {
    const now     = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const time    = now.toLocaleTimeString('en-GB', { hour12: false });

    let line = '';
    switch (level) {
        case 'INFO':    line = `${C.dim}[${time}]${C.reset} ${C.cyan}‹ INFO ›${C.reset} ${message}`; break;
        case 'DEBUG':   line = `${C.dim}[${time}]${C.reset} ${C.cyan}‹ DBG  ›${C.reset} ${C.dim}${message}${C.reset}`; break;
        case 'SUCCESS': line = `${C.dim}[${time}]${C.reset} ${C.green}‹ DONE ›${C.reset} ${message}`; break;
        case 'WARN':    line = `${C.dim}[${time}]${C.reset} ${C.yellow}‹ WARN ›${C.reset} ${message}`; break;
        case 'ERROR':   line = `${C.dim}[${time}]${C.reset} ${C.red}‹ FAIL ›${C.reset} ${C.bright}${message}${C.reset}`; break;
        case 'SYSTEM':  line = `${C.magenta}‹ OMEGA ›${C.reset} ${C.bright}${message}${C.reset}`; break;
    }
    console.log(line);

    // Only persist WARN / ERROR / SYSTEM — skip INFO/SUCCESS to prevent log bloat
    if (level === 'INFO' || level === 'SUCCESS') return;

    if (dateStr !== _dateStr) {
        _dateStr = dateStr;
        _stream.end();
        _stream = _createStream(dateStr);
    }
    _stream.write(`[${now.toISOString()}] [${level}] ${message}\n`);
}

process.on('exit', () => { try { if (!_stream.closed) _stream.end(); } catch {} });

module.exports = {
    info:    (msg, meta) => {
        const extra = typeof meta === 'undefined' ? '' : ` ${JSON.stringify(meta)}`;
        _write('INFO', `${String(msg || '')}${extra}`.trim());
    },
    debug:   (msg, meta) => {
        const extra = typeof meta === 'undefined' ? '' : ` ${JSON.stringify(meta)}`;
        _write('DEBUG', `${String(msg || '')}${extra}`.trim());
    },
    success: (msg, meta) => {
        const extra = typeof meta === 'undefined' ? '' : ` ${JSON.stringify(meta)}`;
        _write('SUCCESS', `${String(msg || '')}${extra}`.trim());
    },
    warn:    (msg, meta) => {
        const extra = typeof meta === 'undefined' ? '' : ` ${JSON.stringify(meta)}`;
        _write('WARN', `${String(msg || '')}${extra}`.trim());
    },
    system:  (msg, meta) => {
        const extra = typeof meta === 'undefined' ? '' : ` ${JSON.stringify(meta)}`;
        _write('SYSTEM', `${String(msg || '')}${extra}`.trim());
    },
    error:   (msg, err)  => {
        const extra = err?.stack || err?.message || (err ? String(err) : '');
        _write('ERROR', extra ? `${msg} ${extra}` : String(msg || ''));
    }
};
