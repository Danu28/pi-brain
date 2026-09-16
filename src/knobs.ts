// Calibration knobs — single surface, tune without code change.
// Mirrors the original "top of index.ts" knob block.

export const MAX_BYTES = 50 * 1024;
export const MAX_LINES = 2000;
export const TAG_BOOST = 1.5;
export const HALF_LIFE_DAYS = 7;
export const HALF_LIFE_FACTOR = 0.5;
export const COMPACT_SMALL = 3;
export const COMPACT_LARGE = 5;
export const REMEMBER_BOOST = 2.0;
export const AUTO_BOOST = 0.6;
export const AUTO_TTL_MS = 3 * 86400000;
export const RECALL_MEMO_MS = 30000;
export const BUDGET_WARN_PCT = 75;
export const BUDGET_STOP_PCT = 85;
export const PRUNE_WARN = 35;
export const PRUNE_CAP = 40;
// QDS relevance thresholds — Question→Delete: drop what doesn't matter
// Human forgetting: remembering noise pollutes memory (keep only ≥4/10), recalling noise diverts AI (show only ≥5.0, else let AI read files)
export const RELEVANCE_MIN_REMEMBER = 4;
export const RELEVANCE_MIN_RECALL = 5.0;