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

// v2 — hash-neural-384 hybrid (pure JS, 0 deps, CPU <1ms, 100% private)
// Set BLEND_SEMANTIC=0 to instantly revert to v1 lexical (no rebuild).
export const NEURAL_DIM = 384;
export const BLEND_LEXICAL = 0.55;
export const BLEND_SEMANTIC = 0.35;
export const BLEND_TAG = 0.10;
export const SIMILAR_COSINE = 0.82;
export const AUTO_TAG_COSINE = 0.75;
export const CODE_TOPK = 3;
export const NEURAL_SEED = 42;