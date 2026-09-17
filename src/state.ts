import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrainEpisode, BrainPlan, Deliberation } from "./types";
export const MODE_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain.json");
export type BrainMode = "strict" | "guided" | "off";
export function readMode(): BrainMode | undefined { try { const v = JSON.parse(readFileSync(MODE_FILE, "utf8")); if (typeof v?.mode === "string" && ["strict","guided","off"].includes(v.mode)) return v.mode as BrainMode; if (typeof v?.enabled === "boolean") return v.enabled ? "strict" : "off"; return undefined; } catch { return undefined; } }
export function writeMode(mode: BrainMode | boolean) { try { const m: BrainMode = typeof mode === "boolean" ? (mode ? "strict" : "off") : mode; mkdirSync(dirname(MODE_FILE), { recursive: true }); writeFileSync(MODE_FILE, JSON.stringify({ mode: m, enabled: m === "strict", ts: Date.now() }), "utf8"); } catch {} }
export function getBrainMode(): BrainMode { const m=(brain as any).brainMode as BrainMode|undefined; if(m) return m; const legacy=(brain as any).brainStrict as boolean|undefined; if(legacy) return "strict"; return "off"; }

export function memoryFilePath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain-memory.json");
}
export function loadMemory(): void {
  try {
    const v = JSON.parse(readFileSync(memoryFilePath(), "utf8"));
    if (Array.isArray(v?.episodes)) for (const e of v.episodes) if (e?.id) brain.episodes.set(e.id, e as BrainEpisode);
    if (Array.isArray(v?.plans)) for (const p of v.plans) if (p?.id && Array.isArray(p.tasks)) brain.plans.set(p.id, p as BrainPlan);
    if (Array.isArray(v?.compactionKept)) brain.lastCompactionKept = v.compactionKept as string[];
  } catch {}
}
// Async save with file-mutation queue when available; falls back to sync so tests without the queue still persist.
let saveChain: Promise<void> = Promise.resolve();
export async function saveMemory(): Promise<boolean> {
  const payload = JSON.stringify({ episodes: [...brain.episodes.values()], plans: [...brain.plans.values()], mode: getBrainMode(), compactionKept: brain.lastCompactionKept, ts: Date.now() });
  const doWrite = async () => {
    try { mkdirSync(dirname(memoryFilePath()), { recursive: true }); writeFileSync(memoryFilePath(), payload, "utf8"); return true; } catch { return false; }
  };
  try {
    const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
    if (typeof withFileMutationQueue === "function") {
      const p = saveChain.then(() => withFileMutationQueue(memoryFilePath(), doWrite));
      saveChain = p.then(()=>{}, ()=>{});
      return await p as boolean;
    }
  } catch {}
  return doWrite();
}
export function saveMemorySync(): boolean {
  try { mkdirSync(dirname(memoryFilePath()), { recursive: true }); writeFileSync(memoryFilePath(), JSON.stringify({ episodes: [...brain.episodes.values()], plans: [...brain.plans.values()], mode: getBrainMode(), ts: Date.now() }), "utf8"); return true; } catch { return false; }
}

export function isVerbose(): boolean { return process.env.PI_BRAIN_VERBOSE === "1" || process.env.PI_BRAIN_TRACE === "1"; }

export const brain = {
  episodes: new Map<string, BrainEpisode>(),
  tokenIndex: new Map<string, Set<string>>(),
  deliberations: [] as Deliberation[],
  brainMode: "off" as BrainMode,
  failureCount: 0,
  thinkSatisfied: false,
  hasRecall: false,
  hasWriteEdit: false,
  hasRemember: false,
  hasPlan: false,
  // legacy compat shim — tests still set brain.brainStrict; kept as alias to brainMode but not read via getBrainMode fallback for perf
  brainStrict: false as any,
  needsPlanUpdate: false as any,
  rule5Warned: false,
  needsDebugThink: false,
  cachedLatestPlan: null as BrainPlan | null,
  plans: new Map<string, BrainPlan>(),
  recallMemo: new Map<string, { ts: number; ranked: BrainEpisode[]; text: string; gen: number }>(),
  memoHits: 0,
  memoMisses: 0,
  memoGen: 0,
  lastCompactionKept: [] as string[],
  lastCompactionSummary: "" as string,
  stats: {
    prune: 0,
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
  brain.brainMode = "off";
  brain.failureCount = 0;
  brain.thinkSatisfied = false;
  brain.hasRecall = false;
  brain.hasWriteEdit = false;
  brain.hasRemember = false;
  brain.hasPlan = false;
  (brain as any).brainStrict = false;
  (brain as any).needsPlanUpdate = false;
  brain.rule5Warned = false;
  brain.needsDebugThink = false;
  brain.cachedLatestPlan = null;
  brain.recallMemo.clear();
  brain.memoHits = 0;
  brain.memoMisses = 0;
  brain.memoGen = 0;
  brain.lastCompactionKept = [];
  brain.lastCompactionSummary = "";
  brain.stats.prune = 0;
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
  const waits = new Map<number, number[]>();
  p.tasks.forEach((t, i) => { if (t.depends?.length) for (const d of t.depends) { if (!waits.has(d)) waits.set(d, []); waits.get(d)!.push(i+1); }});
  return `${p.goal}${(p as any).parentId?` (parent ${(p as any).parentId})`:""}${p.links?.length?` links:[${p.links.join(",")}]`:""}\n` + p.tasks.map((t: any, i:number) => {
    const waiter = waits.get(i)?.length ? ` → waits: T${waits.get(i)!.join(",T")}` : "";
    const depStr = t.depends?.length?` depends:[${t.depends.map((d:number)=>d+1).join(",")}]`:"";
    const waitTag = !t.done && t.depends?.length && t.depends.some((d:number)=>!p.tasks[d]?.done) ? " [blocked]" : "";
    return `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}${t.refs?.length?` refs:${t.refs.join(",")}`:""}${t.check?` check:${t.check.slice(0,30)}`:""}${t.risk!==undefined?` risk:${t.risk}`:""}${depStr}${waitTag}${t.relevance!==undefined?` ${t.relevance.toFixed(1)}/10`:""}${waiter}`;
  }).join("\n");
}
