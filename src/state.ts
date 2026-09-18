import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrainEpisode, BrainPlan, Deliberation } from "./types";
export const MODE_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain.json");
export const PROJECT_MODE_FILE = join(process.cwd(), ".pi", "brain.json");
export type BrainMode = "strict" | "guided" | "off";
export let MODE_SOURCE: string | null = null;
export function readMode(): { mode: BrainMode; source: string } | undefined {
  // S19 per-project override: cwd .pi/brain.json wins over global
  const candidates: [string, string][] = [
    [PROJECT_MODE_FILE, ".pi/brain.json"],
    [MODE_FILE, MODE_FILE],
  ];
  for (const [p, src] of candidates) {
    try {
      const v = JSON.parse(readFileSync(p, "utf8"));
      let m: BrainMode | undefined;
      if (typeof v?.mode === "string" && ["strict","guided","off"].includes(v.mode)) m = v.mode as BrainMode;
      else if (typeof v?.enabled === "boolean") m = v.enabled ? "strict" : "off";
      if (m) { MODE_SOURCE = src; return { mode: m, source: src }; }
    } catch {}
  }
  return undefined;
}
export function readModeSimple(): BrainMode | undefined { const r = readMode(); return r?.mode; }
export function writeMode(mode: BrainMode | boolean) {
  try {
    const m: BrainMode = typeof mode === "boolean" ? (mode ? "strict" : "off") : mode;
    // write to global by default; also write project file if it already exists (preserve per-project intent)
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, JSON.stringify({ mode: m, enabled: m === "strict", ts: Date.now() }), "utf8");
    try { const { existsSync } = require("node:fs"); if (existsSync(PROJECT_MODE_FILE)) { mkdirSync(dirname(PROJECT_MODE_FILE), { recursive: true }); writeFileSync(PROJECT_MODE_FILE, JSON.stringify({ mode: m, enabled: m === "strict", ts: Date.now() }), "utf8"); } } catch {}
    MODE_SOURCE = MODE_FILE;
  } catch {}
}
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
// Async save with file-mutation queue + S21 debounced sidecar (300ms coalesce)
let saveChain: Promise<void> = Promise.resolve();
let saveTimer: any = null;
let pendingSave: { payload: string; resolvers: Array<(v:boolean)=>void> } | null = null;
function flushSave(): Promise<boolean> {
  if (!pendingSave) return Promise.resolve(true);
  const { payload, resolvers } = pendingSave; pendingSave = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const doWrite = async () => {
    try { mkdirSync(dirname(memoryFilePath()), { recursive: true }); writeFileSync(memoryFilePath(), payload, "utf8"); return true; } catch { return false; }
  };
  const exec = async () => {
    try {
      const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
      if (typeof withFileMutationQueue === "function") {
        const p = saveChain.then(() => withFileMutationQueue(memoryFilePath(), doWrite));
        saveChain = p.then(()=>{}, ()=>{});
        return await p as boolean;
      }
    } catch {}
    return doWrite();
  };
  const pr = exec();
  pr.then(v=> resolvers.forEach(r=>r(v)), ()=> resolvers.forEach(r=>r(false)));
  return pr;
}
export async function saveMemory(): Promise<boolean> {
  const payload = JSON.stringify({ episodes: [...brain.episodes.values()], plans: [...brain.plans.values()], mode: getBrainMode(), compactionKept: brain.lastCompactionKept, ts: Date.now() });
  if (!pendingSave) pendingSave = { payload, resolvers: [] };
  else pendingSave.payload = payload;
  return new Promise<boolean>(resolve=> {
    pendingSave!.resolvers.push(resolve);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(()=> { flushSave(); }, 300);
  });
}
export function flushMemorySync(): Promise<boolean> { return flushSave(); }
export function saveMemorySync(): boolean {
  try { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } mkdirSync(dirname(memoryFilePath()), { recursive: true }); writeFileSync(memoryFilePath(), JSON.stringify({ episodes: [...brain.episodes.values()], plans: [...brain.plans.values()], mode: getBrainMode(), ts: Date.now() }), "utf8"); if (pendingSave) pendingSave = null; return true; } catch { return false; }
}
export async function flushMemory(): Promise<boolean> { return flushSave(); }

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

export function getParallelGroups(p: BrainPlan): number[][] {
  // S12: tasks that share no depends are parallelizable — simple grouping by dependency level
  const groups: number[][] = [];
  let cur: number[] = [];
  for (let i=0;i<p.tasks.length;i++) {
    const t:any = p.tasks[i];
    const blocked = !!(t.depends?.length && t.depends.some((d:number)=> !p.tasks[d]?.done));
    if (t.depends?.length) {
      if (cur.length) { groups.push([...cur]); cur = []; }
      groups.push([i]);
    } else {
      if (!blocked) cur.push(i);
      else {
        if (cur.length) { groups.push([...cur]); cur = []; }
        groups.push([i]);
      }
    }
  }
  if (cur.length) groups.push(cur);
  // merge singletons that are adjacent parallel: [[0,1],[2]] when 0,1 parallel, 2 depends
  return groups.filter(g=> g.length);
}
export function renderPlan(p: BrainPlan): string {
  const waits = new Map<number, number[]>();
  p.tasks.forEach((t, i) => { if (t.depends?.length) for (const d of t.depends) { if (!waits.has(d)) waits.set(d, []); waits.get(d)!.push(i+1); }});
  const parallelGroups = getParallelGroups(p);
  const parallelSet = new Set(parallelGroups.filter(g=> g.length>1).flat());
  return `${p.goal}${(p as any).parentId?` (parent ${(p as any).parentId})`:""}${p.links?.length?` links:[${p.links.join(",")}]`:""}\n` + p.tasks.map((t: any, i:number) => {
    const waiter = waits.get(i)?.length ? ` → waits: T${waits.get(i)!.join(",T")}` : "";
    const depStr = t.depends?.length?` depends:[${t.depends.map((d:number)=>d+1).join(",")}]`:"";
    const waitTag = !t.done && t.depends?.length && t.depends.some((d:number)=>!p.tasks[d]?.done) ? " [blocked]" : "";
    const lowTag = t.relevance!==undefined && t.relevance < 4 ? ` [low ${t.relevance.toFixed(1)}/10]` : "";
    const parallelTag = parallelSet.has(i) ? " [parallelizable]" : "";
    return `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}${t.refs?.length?` refs:${t.refs.join(",")}`:""}${t.check?` check:${t.check.slice(0,30)}`:""}${t.risk!==undefined?` risk:${t.risk}`:""}${depStr}${waitTag}${lowTag}${parallelTag}${t.relevance!==undefined?` ${t.relevance.toFixed(1)}/10`:""}${waiter}`;
  }).join("\n");
}
