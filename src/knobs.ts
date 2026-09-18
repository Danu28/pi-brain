// Calibration knobs — single surface, tune without code change.
// File override: pi-brain.knobs.json (cwd or $PI_CODING_AGENT_DIR) merges on load, logged once.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export let MAX_BYTES = 50 * 1024;
export let MAX_LINES = 2000;
export let TAG_BOOST = 1.5;
export let HALF_LIFE_DAYS = 7;
export let HALF_LIFE_FACTOR = 0.5;
export let COMPACT_SMALL = 3;
export let COMPACT_LARGE = 5;
export let REMEMBER_BOOST = 2.0;
export let AUTO_BOOST = 0.6;
export let AUTO_TTL_MS = 3 * 86400000;
export let RECALL_MEMO_MS = 30000;
export let BUDGET_WARN_PCT = 75;
export let BUDGET_STOP_PCT = 85;
export let PRUNE_WARN = 35;
export let PRUNE_CAP = 40;
export let RELEVANCE_MIN_REMEMBER = 4;
export let RELEVANCE_MIN_RECALL = 5.0;
export let SIMILAR_BLOCK_AT = 3;

export let KNOBS_SOURCE: string | null = null;
function loadKnobs() {
  const candidates = [
    join(process.cwd(), "pi-brain.knobs.json"),
    join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain.knobs.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, number>;
      let applied = false;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v !== "number") continue;
        switch (k) {
          case "MAX_BYTES": MAX_BYTES = v; applied = true; break;
          case "MAX_LINES": MAX_LINES = v; applied = true; break;
          case "TAG_BOOST": TAG_BOOST = v; applied = true; break;
          case "HALF_LIFE_DAYS": HALF_LIFE_DAYS = v; applied = true; break;
          case "HALF_LIFE_FACTOR": HALF_LIFE_FACTOR = v; applied = true; break;
          case "COMPACT_SMALL": COMPACT_SMALL = v; applied = true; break;
          case "COMPACT_LARGE": COMPACT_LARGE = v; applied = true; break;
          case "REMEMBER_BOOST": REMEMBER_BOOST = v; applied = true; break;
          case "AUTO_BOOST": AUTO_BOOST = v; applied = true; break;
          case "AUTO_TTL_MS": AUTO_TTL_MS = v; applied = true; break;
          case "RECALL_MEMO_MS": RECALL_MEMO_MS = v; applied = true; break;
          case "PRUNE_CAP": PRUNE_CAP = v; applied = true; break;
          case "RELEVANCE_MIN_REMEMBER": RELEVANCE_MIN_REMEMBER = v; applied = true; break;
          case "RELEVANCE_MIN_RECALL": RELEVANCE_MIN_RECALL = v; applied = true; break;
          case "SIMILAR_BLOCK_AT": SIMILAR_BLOCK_AT = v; applied = true; break;
          case "BUDGET_WARN_PCT": BUDGET_WARN_PCT = v; applied = true; break;
          case "BUDGET_STOP_PCT": BUDGET_STOP_PCT = v; applied = true; break;
        }
      }
      if (applied) {
        KNOBS_SOURCE = p;
        break;
      }
    } catch {}
  }
}
loadKnobs();

export function truncate(text: string): string {
  if (!text) return text;
  const hint = " — full detail via recall{query:\"cue\"} or .pi/agent/pi-brain-memory.json";
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n") + `\n[truncated ${lines.length - MAX_LINES} lines${hint}]`;
  const byteLen = typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : new TextEncoder().encode(text).length;
  if (byteLen > MAX_BYTES) {
    if (typeof Buffer !== "undefined") text = Buffer.from(text, "utf8").slice(0, MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + `\n[truncated to 50KB${hint}]`;
    else text = text.slice(0, MAX_BYTES) + `\n[truncated to 50KB${hint}]`;
  }
  return text;
}
