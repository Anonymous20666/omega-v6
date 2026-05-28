// core/messageQueue.js
// Prevents WhatsApp rate-overlimit by queuing messages

const logger = require('./logger');

class MessageQueue {
    constructor() {
        this.queues = new Map(); // Per-socket queue
        this.lastSent = new Map(); // Per-socket last send time
        this.minDelay = 300; // Minimum 300ms between messages per socket
    }

    async send(sock, jid, content, options = {}) {
        const socketId = sock.user?.id || 'default';
        
        if (!this.queues.has(socketId)) {
            this.queues.set(socketId, []);
            this.lastSent.set(socketId, 0);
        }

        return new Promise((resolve, reject) => {
            const task = { sock, jid, content, options, resolve, reject };
            this.queues.get(socketId).push(task);
            this.process(socketId);
        });
    }

    async process(socketId) {
        const queue = this.queues.get(socketId);
        if (!queue || queue.length === 0) return;

        const now = Date.now();
        const lastSent = this.lastSent.get(socketId) || 0;
        const timeSinceLastSend = now - lastSent;

        if (timeSinceLastSend < this.minDelay) {
            // Wait before processing
            setTimeout(() => this.process(socketId), this.minDelay - timeSinceLastSend);
            return;
        }

        const task = queue.shift();
        if (!task) return;

        try {
            const result = await task.sock.sendMessage(task.jid, task.content, task.options);
            this.lastSent.set(socketId, Date.now());
            task.resolve(result);
        } catch (error) {
            logger.error(`[MessageQueue] Send failed: ${error.message}`);
            task.reject(error);
        }

        // Process next message
        if (queue.length > 0) {
            setTimeout(() => this.process(socketId), this.minDelay);
        }
    }
}

module.exports = new MessageQueue();
