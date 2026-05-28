'use strict';

function envFlag(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw == null || raw === '') return !!defaultValue;
    const normalized = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return !!defaultValue;
}

module.exports = {
    // Keep default compatibility; enable to enforce period-only command triggers.
    strictPeriodPrefix: envFlag('STRICT_PERIOD_PREFIX', false),
    // Centralized response routing can be disabled instantly if needed.
    premiumResponseEngine: envFlag('PREMIUM_RESPONSE_ENGINE', true),
    // Protect link metadata extraction by preserving clean URL-bearing text.
    preserveLinkMetadata: envFlag('PRESERVE_LINK_METADATA', true),
    // Prevent accidental/spammy group metadata mutations.
    groupMetadataGuard: envFlag('GROUP_METADATA_GUARD', true),
    // Queue heavy broadcast/status commands per node for smoother responsiveness.
    heavyCommandScheduler: envFlag('HEAVY_COMMAND_SCHEDULER', true),
};
