// core/ai.tools.js
const tools = [
    {
        name: "getQueueStats",
        description: "Get current BullMQ queue stats",
        execute: async () => {
            const { broadcastQueue } = require('./bullEngine');
            const counts = await broadcastQueue.getJobCounts();
            return counts;
        }
    },
    {
        name: "clearQueue",
        description: "Clear all jobs in queue",
        execute: async () => {
            const { broadcastQueue } = require('./bullEngine');
            await broadcastQueue.drain();
            return "Queue cleared";
        }
    }
];

module.exports = { tools };
