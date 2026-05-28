'use strict';

/**
 * Lightweight in-memory metrics collector for runtime observability.
 */
class MetricsManager {
    constructor() {
        this.counters = new Map();
        this.gauges = new Map();
        this.histograms = new Map();
        this.startedAt = Date.now();
    }

    inc(name, value = 1) {
        const next = (this.counters.get(name) || 0) + Number(value || 0);
        this.counters.set(name, next);
        return next;
    }

    setGauge(name, value) {
        this.gauges.set(name, Number(value || 0));
    }

    observe(name, value) {
        const bucket = this.histograms.get(name) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
        const v = Number(value || 0);
        bucket.count += 1;
        bucket.sum += v;
        bucket.min = Math.min(bucket.min, v);
        bucket.max = Math.max(bucket.max, v);
        this.histograms.set(name, bucket);
    }

    snapshot() {
        const hist = {};
        for (const [name, h] of this.histograms.entries()) {
            hist[name] = {
                count: h.count,
                avg: h.count ? h.sum / h.count : 0,
                min: Number.isFinite(h.min) ? h.min : 0,
                max: Number.isFinite(h.max) ? h.max : 0,
            };
        }

        return {
            uptimeMs: Date.now() - this.startedAt,
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            histograms: hist,
        };
    }
}

module.exports = { MetricsManager };
