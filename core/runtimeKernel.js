'use strict';

const path = require('path');
const { MetricsManager } = require('./metricsManager');
const { LifecycleManager } = require('./lifecycleManager');
const { CacheManager } = require('./cacheManager');
const { ReconnectManager } = require('./reconnectManager');
const { SocketManager } = require('./socketManager');
const { PresenceManager } = require('./presenceManager');
const { SessionIntegrity } = require('./sessionIntegrity');
const { CoreHealthMonitor } = require('./healthMonitor');

const { RetryQueue } = require('../queues/retryQueue');
const { AiQueue } = require('../queues/aiQueue');
const { MediaQueue } = require('../queues/mediaQueue');

const { AiWorker } = require('../workers/aiWorker');
const { MediaWorker } = require('../workers/mediaWorker');
const { StickerWorker } = require('../workers/stickerWorker');
const { CleanupWorker } = require('../workers/cleanupWorker');

const { MetadataService } = require('../services/metadataService');
const { SignalService } = require('../services/signalService');
const { RateLimitService } = require('../services/rateLimitService');
const { AntiSpamService } = require('../services/antiSpamService');

const { MessageRouter } = require('../events/messageRouter');
const { CommandRouter } = require('../events/commandRouter');
const { AiRouter } = require('../events/aiRouter');
const { ModerationRouter } = require('../events/moderationRouter');
const { MediaRouter } = require('../events/mediaRouter');
const { GroupRouter } = require('../events/groupRouter');
const { PollRouter } = require('../events/pollRouter');

let kernel = null;

function getKernel({ logger, engine } = {}) {
    if (kernel) return kernel;

    const metrics = new MetricsManager();
    const lifecycle = new LifecycleManager(logger);
    const cacheManager = new CacheManager(metrics);
    const socketManager = new SocketManager({ logger, metrics });
    const reconnectManager = new ReconnectManager({ logger, lifecycle, metrics });
    const presenceManager = new PresenceManager({ logger, lifecycle });
    const sessionIntegrity = new SessionIntegrity({ logger, sessionsDir: path.join(__dirname, '../data/sessions') });
    const healthMonitor = new CoreHealthMonitor({ logger, lifecycle, metrics, socketManager, cacheManager, reconnectManager });

    const retryQueue = new RetryQueue({ logger });
    const aiQueue = new AiQueue({ logger });
    const mediaQueue = new MediaQueue({ logger });

    const aiWorker = new AiWorker({ logger, aiQueue });
    const mediaWorker = new MediaWorker({ mediaQueue });
    const stickerWorker = new StickerWorker({ mediaQueue });
    const cleanupWorker = new CleanupWorker({ lifecycle, logger, cacheManager });

    const metadataService = new MetadataService({ cacheManager, logger });
    const signalService = new SignalService({ logger, sessionsDir: path.join(__dirname, '../data/sessions') });
    const rateLimitService = new RateLimitService();
    const antiSpamService = new AntiSpamService({ rateLimitService });

    const messageRouter = new MessageRouter({
        logger,
        routers: [
            new CommandRouter({ engine, logger }),
            new ModerationRouter({ antiSpamService }),
            new PollRouter(),
            new MediaRouter({ mediaWorker }),
            new GroupRouter({ metadataService }),
            new AiRouter({ aiWorker, logger }),
        ],
    });

    kernel = {
        metrics,
        lifecycle,
        cacheManager,
        socketManager,
        reconnectManager,
        presenceManager,
        sessionIntegrity,
        healthMonitor,
        retryQueue,
        aiQueue,
        mediaQueue,
        aiWorker,
        mediaWorker,
        stickerWorker,
        cleanupWorker,
        metadataService,
        signalService,
        rateLimitService,
        antiSpamService,
        messageRouter,
        start() {
            cleanupWorker.start();
            healthMonitor.start();
        },
        async shutdown(reason = 'manual') {
            presenceManager.stopAll();
            await lifecycle.shutdown(reason);
        },
    };

    return kernel;
}

module.exports = { getKernel };
