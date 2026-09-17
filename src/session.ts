import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore - tui resolved by pi runtime
import { Text } from "@earendil-works/pi-tui";
import { COMPACT_LARGE, COMPACT_SMALL } from "./knobs";
import { compressEpisodes, rebuildIndex, scoreEpisode } from "./scoring";
import { setFooter } from "./footer";
import { brain, loadMemory, readMode, renderPlan, resetBrain, saveMemory } from "./state";
import type { BrainEpisode, BrainPlan } from "./types";

// Latest usable ctx (captured at session_start/session_tree) for bus-driven UI updates;
// pi.events.on data callbacks carry no ctx.
let lastCtx: any = null;

// Branch-safe rebuild: pi persists extension state as custom entries with the shape
// { type: "custom", customType: "<brain:*>", data: {...} } (session-format.md).
// The legacy branch path is overlaid AFTER the durable sidecar so the newest occurrence
// (branch order is chronological) wins. Returns the last mode entry seen, if any.
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
        if (typeof d?.mode === "string" && ["strict", "guided", "off"].includes(d.mode)) lastMode = d.mode;
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
  // file wins: /pi-brain strict/guided stays across sessions until /pi-brain off
  const effective = fileMode !== undefined ? fileMode : branchMode;
  if (effective !== undefined) {
    const m = typeof effective === "string" ? effective : (effective ? "strict" : "off");
    (brain as any).brainMode = m;
    brain.brainStrict = m === "strict";
  }
}

function refreshFooter(pi: ExtensionAPI, ctx: any) {
  const isStrict = (brain as any).brainMode === "strict" || brain.brainStrict;
  setFooter(pi, ctx, isStrict);
}

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

  // Waking recall: durable sidecar first (compaction-safe, cross-session), then overlay the
  // current branch (newest occurrence wins). Branch-safe like waking, plus /tree re-derivation.
  pi.on("session_start" as any, async (_ev: any, ctx: any) => {
    resetBrain();
    loadMemory();
    const branchMode = rebuildFromBranch(ctx);
    rebuildIndex();
    applyMode(readMode(), branchMode);
    lastCtx = ctx;
    refreshFooter(pi, ctx);
  });

  // /tree navigation changes the active branch without a session_start — re-derive state
  // (todo.ts pattern) so recalls never leak memories from other branches.
  pi.on("session_tree" as any, async (_ev: any, ctx: any) => {
    resetBrain();
    loadMemory();
    rebuildFromBranch(ctx);
    rebuildIndex();
    lastCtx = ctx;
    refreshFooter(pi, ctx);
  });

  pi.on("session_before_compact" as any, async (ev: any) => {
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
    const base = ev?.summary ?? "";
    const summary = base ? `${front}\n\n${base}` : front;
    // Contract (extensions.md / compaction.md): return { compaction: { summary, firstKeptEntryId, tokensBefore } }
    return { compaction: { summary, firstKeptEntryId: ev?.preparation?.firstKeptEntryId ?? "", tokensBefore: ev?.preparation?.tokensBefore ?? 0 } } as any;
  });

  // keep footer in sync if mode toggled anywhere in the process — custom events live on the
  // pi.events bus (event-bus.ts), NOT pi.on (which only dispatches lifecycle events).
  (pi as any).events?.on?.("brain:mode", async (ev: any) => {
    const mode = typeof ev?.mode === "string" ? ev.mode : (typeof ev?.enabled === "boolean" ? (ev.enabled ? "strict" : "off") : ((brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off")));
    refreshFooter(pi, lastCtx);
  });

  // resources_discover deleted — .pi/skills auto-discovered, no handler needed

  pi.on("session_shutdown" as any, async () => {
    // durable flush — sidecar keeps memory across compaction/branch/session boundaries
    saveMemory();
  });
}