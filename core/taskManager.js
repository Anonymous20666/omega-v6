// core/taskManager.js
const logger = require('./logger');
const { system } = require('../config');

class TaskManager {
    constructor() {
        // Unleash concurrency to prevent ANY command lag
        this.concurrency = system?.maxQueueConcurrency || 50; 
        this.running = 0;
        this.queue = [];
        this.activeJobs = new Map();
    }

    async submit(id, taskFn, options = {}) {
        const { priority = 1, timeout = 60000, retries = 0, jitter = [0, 0] } = options;
        if (this.activeJobs.has(id)) return;

        return new Promise((resolve, reject) => {
            const job = { id, taskFn, priority, timeout, retries, jitter, resolve, reject, attempt: 0 };
            this.activeJobs.set(id, job);
            this.queue.push(job);
            this.queue.sort((a, b) => b.priority - a.priority);
            this._processNext();
        });
    }

    _processNext() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            this.running++;
            job.attempt++;
            this._runJob(job);
        }
    }

    async _runJob(job) {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), job.timeout);

        try {
            if (job.jitter[1] > 0) {
                const jitterDelay = Math.floor(Math.random() * (job.jitter[1] - job.jitter[0] + 1)) + job.jitter[0];
                await new Promise(res => setTimeout(res, jitterDelay));
            }
            logger.info(`[TASK] Executing ${job.id}`);

            const result = await job.taskFn(abortController.signal);
            clearTimeout(timeoutId);
            this.activeJobs.delete(job.id);
            job.resolve(result);
        } catch (error) {
            clearTimeout(timeoutId);
            if (job.attempt <= job.retries && error.name !== 'AbortError') {
                logger.warn(`[TASK] Retrying ${job.id}...`);
                job.jitter = [2000, 5000];
                this.queue.push(job);
            } else {
                this.activeJobs.delete(job.id);
                job.reject(error);
            }
        } finally {
            this.running--;
            this._processNext();
        }
    }

    cancel(id) {
        if (this.activeJobs.has(id)) {
            this.activeJobs.delete(id);
            this.queue = this.queue.filter(j => j.id !== id);
        }
    }
    
    getStats() { return { running: this.running, queued: this.queue.length, maxConcurrency: this.concurrency }; }
}
module.exports = new TaskManager();
