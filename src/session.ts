import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore - tui resolved by pi runtime
import { Text } from "@earendil-works/pi-tui";
import { BUDGET_STOP_PCT, BUDGET_WARN_PCT, COMPACT_LARGE, COMPACT_SMALL } from "./knobs";
import { candidatePool, compressEpisodes, rebuildIndex, scoreEpisode } from "./scoring";
import { setFooter } from "./footer";
import { brain, getBrainMode, loadMemory, readMode, renderPlan, resetBrain, saveMemory } from "./state";
import type { BrainEpisode, BrainPlan } from "./types";

let lastCtx: any = null;

function rebuildFromBranch(ctx: any): any {
  let lastMode: any;
  try {
    const branch: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const e of branch) {
      if (!e || typeof e !== "object") continue;
      if (e.type === "custom" && e.customType === "brain:episode") {
        const d = e.data ?? e;
        if (d?.id) brain.episodes.set(d.id, d as BrainEpisode);
      } else if (e.type === "custom" && e.customType === "brain:plan") {
        const d = e.data ?? e;
        if (d?.id && Array.isArray(d.tasks)) brain.plans.set(d.id, d as BrainPlan);
      } else if (e.type === "custom" && e.customType === "brain:mode") {
        const d = e.data ?? e;
        if (typeof d?.mode === "string" && ["strict","guided","off"].includes(d.mode)) lastMode = d.mode;
        else if (typeof d?.enabled === "boolean") lastMode = d.enabled ? "strict" : "off";
      } else if (e.type === "custom" && e.customType === "brain:deliberation") {
        const d = e.data ?? e;
        if (d?.goal) brain.deliberations.push(d as any);
      } else if (e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "remember") {
        const ep = e.message?.details?.episode;
        if (ep?.id) brain.episodes.set(ep.id, ep);
      }
    }
  } catch {}
  return lastMode;
}

function applyMode(fileMode: any, branchMode: any) {
  const fm = fileMode && typeof fileMode === "object" && fileMode.mode ? fileMode.mode : fileMode;
  const effective = fm !== undefined ? fm : branchMode;
  if (effective !== undefined) {
    const m = typeof effective === "string" ? effective : (effective ? "strict" : "off");
    brain.brainMode = m as any;
  }
}

function refreshFooter(pi: ExtensionAPI, ctx: any) {
  const isStrict = getBrainMode() === "strict";
  setFooter(pi, ctx, isStrict);
}

function budgetKeepCount(pct: number | null): number {
  if (pct !== null) {
    if (pct > BUDGET_STOP_PCT) return COMPACT_LARGE; // >85 keep 5
    if (pct > BUDGET_WARN_PCT) return 1; // >75 keep 1
    return COMPACT_SMALL; // <75 keep 3
  }
  return COMPACT_SMALL;
}
export function registerSessionHandlers(pi: ExtensionAPI) {
  try {
    (pi as any).registerEntryRenderer?.("brain:episode", (_entry: any, opts: any) => {
      const d: BrainEpisode = _entry.data ?? _entry;
      const tags = d.tags?.length ? ` [${d.tags.join(",")}]` : "";
      const refs = d.refs?.length ? ` refs:${d.refs.join(",")}` : "";
      const line = opts?.expanded ? `${d.cue}${tags}\n${d.summary}${d.detail ? "\n" + d.detail : ""}${refs}` : `${d.cue}${tags}: ${d.summary.slice(0, 80)}`;
      try { return new (Text as any)(line); } catch { try { return new (Text as any)(String(line), 0, 0); } catch { return new (Text as any)(String(line)); } }
    });
  } catch {}
  try {
    (pi as any).registerEntryRenderer?.("brain:plan", (_entry: any, opts: any) => {
      const d: BrainPlan = _entry.data ?? _entry;
      const line = opts?.expanded ? renderPlan(d) : `${d.goal}: ${d.tasks.filter((t: any)=>t.done).length}/${d.tasks.length} done`;
      try { return new (Text as any)(line); } catch { try { return new (Text as any)(String(line), 0, 0); } catch { return new (Text as any)(String(line)); } }
    });
  } catch {}

  pi.on("session_start" as any, async (_ev: any, ctx: any) => {
    resetBrain();
    loadMemory();
    const branchMode = rebuildFromBranch(ctx);
    rebuildIndex();
    applyMode(readMode(), branchMode);
    lastCtx = ctx;
    refreshFooter(pi, ctx);
  });

  pi.on("session_tree" as any, async (_ev: any, ctx: any) => {
    resetBrain();
    loadMemory();
    rebuildFromBranch(ctx);
    rebuildIndex();
    lastCtx = ctx;
    refreshFooter(pi, ctx);
  });

  pi.on("session_before_compact" as any, async (ev: any, ctx:any) => {
    let pct: number | null = null;
    try { const u = (ctx as any)?.getContextUsage?.() ?? (pi as any).getContextUsage?.() ?? ev?.preparation ?? null; if (u?.percent !== undefined) pct = u.percent; else if (u?.tokensBefore && u?.contextWindow) pct = Math.round(u.tokensBefore / u.contextWindow * 100); } catch {}
    const query = brain.deliberations[brain.deliberations.length-1]?.goal ?? (brain.cachedLatestPlan?.goal ?? "");
    let ranked: BrainEpisode[];
    if (query) {
      const scored = [...brain.episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now()).map(e=>({e,s:scoreEpisode(e,query)})).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts);
      ranked = scored.length && scored.every(x=>x.s===0) ? [...brain.episodes.values()].sort((a,b)=>b.ts-a.ts) : scored.map(x=>x.e);
    } else {
      ranked = [...brain.episodes.values()].sort((a, b) => b.ts - a.ts);
    }
    const sliced = ranked.slice(0, COMPACT_LARGE);
    if (!sliced.length) return;
    const keepN = budgetKeepCount(pct);
    const keep = sliced.slice(0, keepN);
    const front = `Brain episodes:\n${compressEpisodes(keep)}`;
    const base = ev?.summary ?? "";
    const summary = base ? `${front}\n\n${base}` : front;
    const keptIds = keep.map(e=>e.id);
    brain.lastCompactionKept = keptIds;
    brain.lastCompactionSummary = front;
    try { const { flushMemory } = await import("./state"); await flushMemory(); } catch { try { await saveMemory(); } catch {} }
    return { compaction: { summary, firstKeptEntryId: ev?.preparation?.firstKeptEntryId ?? "", tokensBefore: ev?.preparation?.tokensBefore ?? 0 } } as any;
  });

  (pi as any).events?.on?.("brain:mode", async () => {
    refreshFooter(pi, lastCtx);
  });

  // S10 prefetch recall on before_agent_start so next recall is cache hit (no extra turn)
  pi.on("before_agent_start" as any, async (ev:any, ctx:any) => {
    try { const q = (ev?.prompt ?? "").slice(0,120); if(!q) return; const pool=candidatePool(q).slice(0,2).map(e=>e.id); if(pool.length) (brain as any)._prefetch = { q, ids: pool, ts: Date.now() }; } catch {}
    // S02 gist hot stays via lastCompactionSummary already; no extra
    // S21 pre-rank idle: precompute top 3 ids for next recall skip
    try { const all=[...brain.episodes.values()].slice(0,3).map(e=>e.id); if(all.length) (brain as any)._preRank = all; } catch {}
  });
  pi.on("session_shutdown" as any, async () => {
    try { const { flushMemory } = await import("./state"); await flushMemory(); } catch { await saveMemory(); }
  });
}
