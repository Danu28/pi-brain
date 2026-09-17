import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrainEpisode, BrainPlan, Deliberation } from "./types";
export const MODE_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain.json");
export type BrainMode = "strict" | "guided" | "off";
export function readMode(): BrainMode | undefined { try { const v = JSON.parse(readFileSync(MODE_FILE, "utf8")); if (typeof v?.mode === "string" && ["strict","guided","off"].includes(v.mode)) return v.mode as BrainMode; if (typeof v?.enabled === "boolean") return v.enabled ? "strict" : "off"; return undefined; } catch { return undefined; } }
export function writeMode(mode: BrainMode | boolean) { try { const m: BrainMode = typeof mode === "boolean" ? (mode ? "strict" : "off") : mode; mkdirSync(dirname(MODE_FILE), { recursive: true }); writeFileSync(MODE_FILE, JSON.stringify({ mode: m, enabled: m === "strict", ts: Date.now() }), "utf8"); } catch {} }
export function getBrainMode(): BrainMode { return (brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off"); }

// Module-singleton brain state. pi loads an extension once per process, so a
// module singleton (plus resetBrain() on session_start) preserves the original
// "one factory, one Map" behavior — branch-safe waking, no class/DI.
export function isVerbose(): boolean { return process.env.PI_BRAIN_VERBOSE === "1" || process.env.PI_BRAIN_TRACE === "1"; }

export const brain = {
  // hippocampus — durable, branch-scoped
  episodes: new Map<string, BrainEpisode>(),
  // incremental token → ids index (O(1) recall, rebuilt on session_start)
  tokenIndex: new Map<string, Set<string>>(),
  // PFC scratchpad — deliberations (not durable, per-turn working memory)
  deliberations: [] as Deliberation[],
  // /pi-brain mode gate — branch-durable, defaults off: strict=block, guided=nudge, off=disabled
  brainMode: "off" as BrainMode,
  brainStrict: false, // legacy mirror for compat (true when mode==="strict")
  failureCount: 0, // consecutive write/edit/bash failures — 2 continuous triggers think
  // strict workflow enforcement (per-agent run) — clean: explicit recall/think flags, no hidden auto-encode
  thinkSatisfied: false,
  hasRecall: false,
  hasWriteEdit: false,
  hasRemember: false,
  hasPlan: false, // think+plan mandatory (strict): plan tool success sets this
  rule5Warned: false,
  needsDebugThink: false, // unhappy path: 2 continuous failures → must think before retry
  needsPlanUpdate: false, // deprecated — kept for compat, not used as hard block
  cachedLatestPlan: null as BrainPlan | null,
  // plan — ordered tasklist after think
  plans: new Map<string, BrainPlan>(),
  // T9 recall memo
  recallMemo: new Map<string, { ts: number; ranked: BrainEpisode[]; text: string }>(),
  memoHits: 0,
  memoMisses: 0,
  // Tier 2 verbose counters — always incremented, surfaced in brain-status and via verbose notify
  stats: {
    skip: 0,
    autoEncode: 0,
    touch: 0,
    prune: 0,
    budgetTrim: 0,
    block: 0,
    dedup: 0,
    nudge: 0,
    audit: 0,
  },
};

export function resetBrain() {
  brain.episodes.clear();
  brain.tokenIndex.clear();
  brain.plans.clear();
  brain.deliberations.length = 0;
  (brain as any).brainMode = "off";
  brain.brainStrict = false;
  (brain as any).failureCount = 0;
  brain.thinkSatisfied = false;
  brain.hasRecall = false;
  brain.hasWriteEdit = false;
  brain.hasRemember = false;
  (brain as any).hasPlan = false;
  brain.rule5Warned = false;
  brain.needsDebugThink = false;
  brain.needsPlanUpdate = false;
  brain.cachedLatestPlan = null;
  brain.recallMemo.clear();
  brain.memoHits = 0;
  brain.memoMisses = 0;
  brain.stats.skip = 0;
  brain.stats.autoEncode = 0;
  brain.stats.touch = 0;
  brain.stats.prune = 0;
  brain.stats.budgetTrim = 0;
  brain.stats.block = 0;
  brain.stats.dedup = 0;
  brain.stats.nudge = 0;
  brain.stats.audit = 0;
}

export function latestPlan(): BrainPlan | null {
  const p = brain.cachedLatestPlan ?? [...brain.plans.values()].sort((a, b) => b.ts - a.ts)[0] ?? null;
  if (p) brain.cachedLatestPlan = p;
  return p;
}

export function isPlanDone(): boolean {
  const p = latestPlan();
  return !!p && p.tasks.length > 0 && p.tasks.every((t) => t.done);
}

export function renderPlan(p: BrainPlan): string {
  return `${p.goal}${(p as any).parentId?` (parent ${(p as any).parentId})`:""}${p.links?.length?` links:[${p.links.join(",")}]`:""}\n` + p.tasks.map((t: any, i:number) => `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}${t.refs?.length?` refs:${t.refs.join(",")}`:""}${t.check?` check:${t.check.slice(0,30)}`:""}${t.risk!==undefined?` risk:${t.risk}`:""}${t.depends?.length?` depends:[${t.depends.map((d:number)=>d+1).join(",")}]`:""}${t.relevance!==undefined?` ${t.relevance.toFixed(1)}/10`:""}`).join("\n");
}