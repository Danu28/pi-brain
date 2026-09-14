import type { BrainEpisode, BrainPlan, Deliberation } from "./types";

// Module-singleton brain state. pi loads an extension once per process, so a
// module singleton (plus resetBrain() on session_start) preserves the original
// "one factory, one Map" behavior — branch-safe waking, no class/DI.
export const brain = {
  // hippocampus — durable, branch-scoped
  episodes: new Map<string, BrainEpisode>(),
  // incremental token → ids index (O(1) recall, rebuilt on session_start)
  tokenIndex: new Map<string, Set<string>>(),
  // PFC scratchpad — deliberations (not durable, per-turn working memory)
  deliberations: [] as Deliberation[],
  // /pi-brain strict gate — branch-durable, defaults off
  brainStrict: false,
  // strict workflow enforcement (per-agent run)
  thinkSatisfied: false,
  hasWriteEdit: false,
  hasRemember: false,
  rule5Warned: false,
  needsDebugThink: false, // unhappy path: failure → must think before retry
  needsPlanUpdate: false, // after debug think, must update plan before retry
  consecutiveFailures: 0, // 2-strike rule: only 2 continuous failures trigger unhappy path
  cachedLatestPlan: null as BrainPlan | null,
  // plan — ordered tasklist after think
  plans: new Map<string, BrainPlan>(),
  // T9 recall memo
  recallMemo: new Map<string, { ts: number; ranked: BrainEpisode[]; text: string }>(),
  memoHits: 0,
  memoMisses: 0,
};

export function resetBrain() {
  brain.episodes.clear();
  brain.tokenIndex.clear();
  brain.plans.clear();
  brain.deliberations.length = 0;
  brain.brainStrict = false;
  brain.thinkSatisfied = false;
  brain.hasWriteEdit = false;
  brain.hasRemember = false;
  brain.rule5Warned = false;
  brain.needsDebugThink = false;
  brain.needsPlanUpdate = false;
  brain.consecutiveFailures = 0;
  brain.cachedLatestPlan = null;
  brain.recallMemo.clear();
  brain.memoHits = 0;
  brain.memoMisses = 0;
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
  return `${p.goal}\n` + p.tasks.map((t, i) => `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}`).join("\n");
}