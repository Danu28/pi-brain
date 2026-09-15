import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore - tui resolved by pi runtime
import { Text } from "@earendil-works/pi-tui";
import { COMPACT_LARGE, COMPACT_SMALL, PRUNE_CAP } from "./knobs";
import { pruneExpired, rebuildIndex } from "./recall";
import { compressEpisodes } from "./gist";
import { scoreEpisode } from "./scoring";
import { brain, resetBrain } from "./state";
import { readMode } from "./storage";
import { syncFooter } from "./ui";
import type { BrainEpisode, BrainPlan } from "./types";
import { renderPlan } from "./state";

export function registerSessionHandlers(pi: ExtensionAPI) {
  // TUI renderer for brain:episode — collapsed cue, expanded detail (not in LLM context)
  try {
    (pi as any).registerEntryRenderer?.("brain:episode", (_entry: any, opts: any, theme: any) => {
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

  // T04: waking recall — rebuild from branch (branch-safe, like waking)
  pi.on("session_start" as any, async (_ev: any, ctx: any) => {
    resetBrain();
    try {
      const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
      let lastMode: boolean | undefined;
      for (const e of branch) {
        if (e.type === "entry" && (e.entryType === "brain:episode" || e.entry_type === "brain:episode")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.id) brain.episodes.set(d.id, d as BrainEpisode);
        }
        if (e.type === "entry" && (e.entryType === "brain:plan" || e.entry_type === "brain:plan")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.id && Array.isArray(d.tasks)) brain.plans.set(d.id, d as BrainPlan);
        }
        if (e.type === "entry" && (e.entryType === "brain:mode" || e.entry_type === "brain:mode")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (typeof d?.enabled === "boolean") lastMode = d.enabled;
        }
        if (e.type === "entry" && (e.entryType === "brain:deliberation" || e.entry_type === "brain:deliberation")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.goal) brain.deliberations.push(d as any);
        }
        if (e.type === "message" && (e as any).message?.role === "toolResult" && (e as any).message?.toolName === "remember") {
          const ep = (e as any).message?.details?.episode;
          if (ep?.id) brain.episodes.set(ep.id, ep);
        }
      }
      // rebuild incremental index
      rebuildIndex();
      // v2: hydrate embeddings cache from persisted base64 (lazy: old episodes without embedding → cache miss → cosine 0)
      try {
        const { fromBase64 } = await import("./neural.js");
        for (const [id, ep] of brain.episodes) {
          if (ep.embedding) {
            try { const v = (fromBase64 as any)(ep.embedding); if (v?.length === 384) brain.embeddings.set(id, v); } catch {}
          }
        }
      } catch {}
      // T2 prune expired after rebuild (also does LRU eviction if >PRUNE_CAP, so single call suffices)
      pruneExpired(pi);
      // file wins: /pi-brain on stays on across sessions until /pi-brain off
      const fileMode = readMode();
      if (fileMode !== undefined) brain.brainStrict = fileMode;
      else if (lastMode !== undefined) brain.brainStrict = lastMode;
    } catch {}
    // reflect in footer — creative pulse survives reload
    syncFooter(pi, ctx, brain.brainStrict);
  });

  pi.on("session_before_compact" as any, async (ev: any) => {
    if (!brain.brainStrict) return; // really off — no compaction inject
    // T4 scored compaction (reuse scoreEpisode + deliberation goal)
    const query = brain.deliberations[brain.deliberations.length-1]?.goal ?? (brain.cachedLatestPlan?.goal ?? "");
    let ranked: BrainEpisode[];
    if (query) {
      const scored = [...brain.episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now()).map(e=>({e,s:scoreEpisode(e,query)})).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts);
      ranked = scored.length && scored.every(x=>x.s===0) ? [...brain.episodes.values()].sort((a,b)=>b.ts-a.ts) : scored.map(x=>x.e); // single scan — fix C1 shadow
    } else {
      ranked = [...brain.episodes.values()].sort((a, b) => b.ts - a.ts);
    }
    // prefer remember over auto implicitly via sourceBoost already in scoreEpisode
    const sliced = ranked.slice(0, COMPACT_LARGE);
    if (!sliced.length) return;
    const keep = sliced.length <= 15 ? sliced.slice(0, COMPACT_SMALL) : sliced.slice(0, COMPACT_LARGE);
    const front = `Brain episodes:\n${compressEpisodes(keep)}`;
    const summary = ev?.summary ? `${front}\n\n${ev.summary}` : front;
    return { summary } as any;
  });

  // resources_discover deleted — .pi/skills auto-discovered, no handler needed

  pi.on("session_shutdown" as any, async () => {
    // idempotent — entries already durable, nothing to flush
  });
}