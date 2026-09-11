import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore - typebox resolved by pi runtime
import { Type } from "typebox";
// @ts-ignore - tui resolved by pi runtime
import { Text } from "@earendil-works/pi-tui";

// pi-brain — human brain → pi extension
// 5-step: Question→Delete→Simplify→Accelerate→Automate
// One factory, one closure, one Map — no class/DI

type Episode = {
  id: string;
  cue: string;
  summary: string;
  detail?: string;
  ts: number;
  source: string;
  tags?: string[];
  refs?: string[];
};

type Plan = {
  id: string;
  goal: string;
  tasks: { title: string; done: boolean }[];
  ts: number;
};

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
// ponytail: calibration knobs — tune like myelination thickness
const TAG_BOOST = 1.5;
const HALF_LIFE_DAYS = 7;
const HALF_LIFE_FACTOR = 0.95;
const DEFAULT_INJECT_COUNT = 1;
const DEFAULT_INJECT_SCORED = 2;
const STRICT_INJECT_MAX = 5;
const COMPACT_SMALL = 3;
const COMPACT_LARGE = 5;

function truncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n") + `\n[truncated ${lines.length - MAX_LINES} lines]`;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    text = Buffer.from(text, "utf8").slice(0, MAX_BYTES).toString("utf8") + "\n[truncated to 50KB]";
  }
  return text;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function sanitizeTags(tags?: string[]): string[] | undefined {
  if (!tags?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const k = t.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}
function sanitizeRefs(refs?: string[]): string[] | undefined {
  if (!refs?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const v = r.trim().slice(0, 200);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 5) break;
  }
  return out.length ? out : undefined;
}
function parseSince(since?: string | number): number | undefined {
  if (since === undefined || since === null || since === "") return undefined;
  if (typeof since === "number") return Date.now() - since;
  const s = String(since).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Date.now() - parseInt(s, 10);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/);
  if (!m) {
    const t = Date.parse(s);
    return isNaN(t) ? undefined : t;
  }
  const n = parseFloat(m[1]);
  const unit = m[2] || "ms";
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return Date.now() - n * (mult[unit] ?? 1);
}

function scoreEpisode(e: Episode, query: string): number {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const qLower = query.toLowerCase();
  let s = 0;
  const cueL = e.cue.toLowerCase();
  const sumL = e.summary.toLowerCase();
  const detL = (e.detail ?? "").toLowerCase();
  if (cueL.includes(qLower)) s += 2;
  if (sumL.includes(qLower)) s += 1;
  for (const t of terms) {
    const cueCount = cueL.split(t).length - 1;
    const sumCount = sumL.split(t).length - 1;
    const detCount = detL.split(t).length - 1;
    s += cueCount * 2 + sumCount * 1 + detCount * 0.5;
  }
  return s;
}
function decayScore(score: number, ts: number): number {
  const days = (Date.now() - ts) / 86400000;
  if (days <= 0) return score;
  return score * Math.pow(HALF_LIFE_FACTOR, days / HALF_LIFE_DAYS);
}

export default function (pi: ExtensionAPI) {
  const episodes = new Map<string, Episode>();
  const deliberations: { goal: string; hypotheses: string[]; conclusion?: string; ts: number }[] = [];
  let brainStrict = false;
  let thinkSatisfied = false;
  let hasWriteEdit = false;
  let hasRemember = false;
  let needsDebugThink = false;
  let needsPlanUpdate = false;
  let cachedLatestPlan: Plan | null = null;
  let lastFailedTool = "";
  let lastErrorSnippet = "";
  const plans = new Map<string, Plan>();
  const renderPlan = (p: Plan) => `${p.goal}\n` + p.tasks.map((t, i) => `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}`).join("\n");

  // incremental index — ponytail: stdlib Maps/Sets, no vector DB
  const tokenIndex = new Map<string, Set<string>>();
  const idTokens = new Map<string, string[]>();
  const tagIndex = new Map<string, Set<string>>();
  // habit confirm gate
  const habitPending = new Set<string>();

  function indexEpisode(e: Episode) {
    const tokens = [...new Set([...tokenize(e.cue), ...tokenize(e.summary), ...tokenize(e.detail ?? "")])];
    idTokens.set(e.id, tokens);
    for (const tok of tokens) {
      if (!tokenIndex.has(tok)) tokenIndex.set(tok, new Set());
      tokenIndex.get(tok)!.add(e.id);
    }
    if (e.tags) {
      for (const tag of e.tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
        tagIndex.get(tag)!.add(e.id);
      }
    }
  }
  function rebuildIndex() {
    tokenIndex.clear(); idTokens.clear(); tagIndex.clear();
    for (const e of episodes.values()) indexEpisode(e);
  }
  function candidateIdsForQuery(query: string, filterTags?: string[]): Set<string> | null {
    const qTokens = tokenize(query);
    let candidates: Set<string> | null = null;
    if (qTokens.length) {
      // union of token sets (any term hit), fallback null if no hit
      const union = new Set<string>();
      let hit = false;
      for (const tok of qTokens) {
        const s = tokenIndex.get(tok);
        if (s) { hit = true; for (const id of s) union.add(id); }
      }
      if (hit) candidates = union;
    }
    if (filterTags?.length) {
      const tagUnion = new Set<string>();
      for (const t of filterTags.map((x) => x.toLowerCase())) {
        const s = tagIndex.get(t);
        if (s) for (const id of s) tagUnion.add(id);
      }
      if (candidates && tagUnion.size) {
        // T08: tagIndex ∪ token candidates — keep union
        for (const id of tagUnion) candidates.add(id);
      } else if (tagUnion.size) {
        candidates = tagUnion;
      } else if (filterTags.length && !candidates) {
        // tags requested but no index hit → empty set (will fallback to scan)
        candidates = new Set();
      }
    }
    return candidates;
  }

  try {
    (pi as any).registerEntryRenderer?.("brain:episode", (entry: any, opts: any) => {
      const d: Episode = entry.data ?? entry;
      const tagsLine = d.tags?.length ? ` tags:[${d.tags.join(",")}]` : "";
      const refsLine = d.refs?.length ? ` refs:[${d.refs.join(",")}]` : "";
      const line = opts?.expanded ? `${d.cue}${tagsLine}${refsLine}\n${d.summary}${d.detail ? "\n" + d.detail : ""}` : `${d.cue}: ${d.summary.slice(0, 80)}${tagsLine}`;
      try { return new (Text as any)(line); } catch { try { return new (Text as any)(String(line), 0, 0); } catch { return new (Text as any)(String(line)); } }
    });
  } catch {}
  try {
    (pi as any).registerEntryRenderer?.("brain:plan", (entry: any, opts: any) => {
      const d: Plan = entry.data ?? entry;
      const line = opts?.expanded ? renderPlan(d) : `${d.goal}: ${d.tasks.filter((t: any)=>t.done).length}/${d.tasks.length} done`;
      try { return new (Text as any)(line); } catch { try { return new (Text as any)(String(line), 0, 0); } catch { return new (Text as any)(String(line)); } }
    });
  } catch {}

  pi.on("session_start" as any, async (_ev: any, ctx: any) => {
    episodes.clear();
    plans.clear();
    deliberations.length = 0;
    brainStrict = false;
    thinkSatisfied = false;
    hasWriteEdit = false;
    hasRemember = false;
    needsDebugThink = false;
    needsPlanUpdate = false;
    cachedLatestPlan = null;
    lastFailedTool = "";
    lastErrorSnippet = "";
    tokenIndex.clear(); idTokens.clear(); tagIndex.clear(); habitPending.clear();
    try {
      const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
      let lastMode: boolean | undefined;
      for (const e of branch) {
        if (e.type === "entry" && (e.entryType === "brain:episode" || e.entry_type === "brain:episode")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.id) episodes.set(d.id, d as Episode);
        }
        if (e.type === "entry" && (e.entryType === "brain:plan" || e.entry_type === "brain:plan")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.id && Array.isArray(d.tasks)) plans.set(d.id, d as Plan);
        }
        if (e.type === "entry" && (e.entryType === "brain:mode" || e.entry_type === "brain:mode")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (typeof d?.enabled === "boolean") lastMode = d.enabled;
        }
        if (e.type === "message" && (e as any).message?.role === "toolResult" && (e as any).message?.toolName === "remember") {
          const ep = (e as any).message?.details?.episode;
          if (ep?.id) episodes.set(ep.id, ep);
        }
      }
      if (lastMode !== undefined) brainStrict = lastMode;
    } catch {}
    rebuildIndex();
    try { (pi as any)._brainStrict = brainStrict; } catch {}
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Explicitly encode an episode to brain memory (hippocampus). Use cue as associative key.",
    parameters: Type.Object({
      cue: Type.String({ description: "Associative cue (short key for recall)" }),
      summary: Type.String({ description: "One-line summary of episode" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags (kebab, ≤8) for grouping/filtering" })),
      refs: Type.Optional(Type.Array(Type.String(), { description: "Optional file refs (≤5) for jump-to-code" })),
    }),
    async execute(_id, params: any, _signal, _onUpdate, _ctx) {
      const ep: Episode = {
        id: `${params.cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        cue: truncate(params.cue),
        summary: truncate(params.summary),
        detail: params.detail ? truncate(params.detail) : undefined,
        tags: sanitizeTags(params.tags),
        refs: sanitizeRefs(params.refs),
        ts: Date.now(),
        source: "remember",
      };
      await (pi as any).appendEntry?.("brain:episode", ep);
      episodes.set(ep.id, ep);
      indexEpisode(ep);
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id}${ep.tags ? ` tags:[${ep.tags.join(",")}]` : ""}${ep.refs ? ` refs:[${ep.refs.join(",")}]` : ""}` }], details: { id: ep.id, episode: ep } };
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Associative recall: TF-IDF cue→ranked episodes (pattern completion). No vector DB, lazy scan over session.",
    parameters: Type.Object({
      query: Type.String({ description: "Cue to recall by" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (any match)" })),
      source: Type.Optional(Type.String({ description: 'Filter by source: "remember" | "auto"' })),
      since: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: 'Filter since: "7d" | "24h" | ms | ISO date' })),
    }),
    async execute(_id, params: any, signal) {
      const limit = params.limit ?? 5;
      const filterTags = params.tags?.map((t: string) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")).filter(Boolean) as string[] | undefined;
      const sinceTs = parseSince(params.since);
      const sourceFilter = params.source ? String(params.source).toLowerCase() : undefined;

      // pre-filter by tags/source/since before scoring
      let pool: Episode[] = [...episodes.values()];
      if (filterTags?.length) {
        const tagSet = new Set(filterTags);
        pool = pool.filter((e) => e.tags?.some((t) => tagSet.has(t.toLowerCase())));
        if (!pool.length && params.query.trim() === "") {
          // tag filter yielded nothing — return empty
          const txt = "No episodes match tags filter.";
          return { content: [{ type: "text", text: txt }], details: { episodes: [] } };
        }
      }
      if (sourceFilter) pool = pool.filter((e) => e.source.toLowerCase() === sourceFilter);
      if (sinceTs !== undefined) pool = pool.filter((e) => e.ts >= sinceTs);

      // fast path via incremental index when pool is full set and no source/since narrowing already done via filter
      const useIndex = !sourceFilter && sinceTs === undefined && episodes.size > 20;
      let scored: { e: Episode; s: number }[] = [];
      if (useIndex && (params.query.trim() || filterTags?.length)) {
        const candIds = candidateIdsForQuery(params.query, filterTags);
        if (candIds !== null) {
          if (candIds.size === 0) {
            // no token/tag hit — empty unless we fallback
            scored = [];
          } else {
            const candPool = [...candIds].map((id) => episodes.get(id)!).filter(Boolean).filter((e) => {
              if (sourceFilter && e.source.toLowerCase() !== sourceFilter) return false;
              if (sinceTs !== undefined && e.ts < sinceTs) return false;
              if (filterTags?.length && !e.tags?.some((t) => filterTags.includes(t.toLowerCase()))) return false;
              return true;
            });
            scored = candPool.map((e) => {
              let s = scoreEpisode(e, params.query);
              if (filterTags?.length && e.tags) {
                const hits = e.tags.filter((t) => filterTags.includes(t.toLowerCase())).length;
                s += hits * TAG_BOOST;
              }
              s = decayScore(s, e.ts);
              return { e, s };
            }).filter((x) => x.s > 0 || params.query.trim() === "");
          }
          // if scored empty but query empty+tags had pool, use pool
          if (!scored.length && params.query.trim() === "" && filterTags?.length) {
            scored = pool.map((e) => ({ e, s: decayScore((e.tags?.filter((t) => filterTags.includes(t.toLowerCase())).length ?? 0) * TAG_BOOST || 0.1, e.ts) }));
          }
          if (!scored.length && params.query.trim() !== "") {
            // fallback to full pool scan if index yielded nothing (tag-only already handled)
            scored = pool.map((e) => {
              let s = scoreEpisode(e, params.query);
              if (filterTags?.length && e.tags) s += e.tags.filter((t) => filterTags.includes(t.toLowerCase())).length * TAG_BOOST;
              return { e, s: decayScore(s, e.ts) };
            }).filter((x) => x.s > 0 || params.query.trim() === "");
          }
        } else {
          // no query tokens and no tags → full scan
          scored = pool.map((e) => {
            let s = scoreEpisode(e, params.query);
            if (filterTags?.length && e.tags) s += e.tags.filter((t) => filterTags.includes(t.toLowerCase())).length * TAG_BOOST;
            return { e, s: decayScore(s, e.ts) };
          }).filter((x) => x.s > 0 || params.query.trim() === "");
        }
      } else {
        scored = pool.map((e) => {
          let s = scoreEpisode(e, params.query);
          if (filterTags?.length && e.tags) s += e.tags.filter((t) => filterTags.includes(t.toLowerCase())).length * TAG_BOOST;
          return { e, s: decayScore(s, e.ts) };
        }).filter((x) => x.s > 0 || params.query.trim() === "");
      }

      scored.sort((a, b) => b.s - a.s || b.e.ts - a.e.ts);
      let ranked = scored.slice(0, limit).map((x) => x.e);
      if (!ranked.length) ranked = pool.sort((a, b) => b.ts - a.ts).slice(0, limit);
      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;

      const text = ranked.length
        ? ranked.map((e) => `[${e.cue}]${e.tags?.length ? ` {${e.tags.join(",")}}` : ""}${e.refs?.length ? ` refs:${e.refs.join(",")}` : ""} ${e.summary}${e.detail ? " — " + e.detail.slice(0, 120) : ""}`).join("\n")
        : "No episodes yet. Use remember to encode.";
      return { content: [{ type: "text", text: truncate(text) }], details: { episodes: ranked } };
    },
  });

  pi.registerTool({
    name: "brain_status",
    label: "Brain status",
    description: "How full is the brain? Episode count + context usage (metacognition). Emits brain:overload if >80%.",
    parameters: Type.Object({}),
    async execute(_id, _p, _sig, _upd, ctx: any) {
      let usage: any = undefined;
      try { usage = ctx?.getContextUsage?.() ?? undefined; } catch {}
      const count = episodes.size;
      const pct = usage?.percent ?? (usage?.used && usage?.total ? Math.round((usage.used / usage.total) * 100) : undefined);
      const overloaded = (pct !== undefined && pct > 80) || count > 50;
      if (overloaded) (pi as any).events?.emit?.("brain:overload", { episodes: count, percent: pct });
      const latestPlan = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
      if (latestPlan) cachedLatestPlan = latestPlan;
      const planStr = latestPlan ? `${latestPlan.goal}: ${latestPlan.tasks.filter((t)=>t.done).length}/${latestPlan.tasks.length} done` : "no plan";
      const recentCues = [...episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map((e)=>e.cue).join(", ") || "—";
      const tbl = `Episodes: ${count} | Deliberations: ${deliberations.length} | Plan: ${planStr}\nTokens: ${usage?.used ?? "?"} / ${usage?.total ?? "?"}${pct !== undefined ? ` (${pct}%)` : ""}${overloaded ? " [overload]" : ""}\nRecent: ${recentCues}\nIndex: ${tokenIndex.size} tokens, ${tagIndex.size} tags${overloaded ? "\n[overload: consider compaction/pruning]" : ""}`;
      return { content: [{ type: "text", text: tbl }], details: { episodes: count, tokens: usage, recent: [...episodes.values()].slice(-3), overloaded, deliberations: deliberations.slice(-3), plan: latestPlan } };
    },
  });

  pi.registerTool({
    name: "think",
    label: "Think",
    description: "PFC deliberation scratchpad: encode a reasoning step (goal + hypotheses) to working memory, injected next turn.",
    parameters: Type.Object({
      goal: Type.String({ description: "Reasoning goal or question" }),
      hypotheses: Type.Array(Type.String(), { description: "Hypotheses / approaches to consider", minItems: 1, maxItems: 3 }),
      conclusion: Type.Optional(Type.String({ description: "Tentative conclusion" })),
    }),
    async execute(_id, params, _signal) {
      if (needsDebugThink && !params.goal.trim().toLowerCase().startsWith("debug")) {
        return { content: [{ type: "text", text: "Blocked: unhappy path requires think{goal:'debug <failed Task N>', hypotheses:[cause,fix]} — goal must start with 'debug'" }], details: { error: "debug required" } } as any;
      }
      const wasDebug = needsDebugThink;
      const entry = { goal: truncate(params.goal), hypotheses: params.hypotheses.map(truncate), conclusion: params.conclusion ? truncate(params.conclusion) : undefined, ts: Date.now() };
      deliberations.push(entry as any);
      if (deliberations.length > 10) deliberations.shift();
      thinkSatisfied = true;
      needsDebugThink = false;
      if (wasDebug) needsPlanUpdate = true;
      (pi as any).events?.emit?.("brain:deliberation", entry);
      const text = `Deliberation saved: ${params.goal}\n- ${params.hypotheses.join("\n- ")}${params.conclusion ? `\n=> ${params.conclusion}` : ""}`;
      return { content: [{ type: "text", text: truncate(text) }], details: { deliberation: entry } };
    },
  });

  const synthesizeParams = Type.Object({
    cues: Type.Array(Type.String(), { description: "2-3 cues to combine", minItems: 2, maxItems: 3 }),
    prompt: Type.Optional(Type.String({ description: "Synthesis prompt (e.g. approach to ...)" })),
  });
  async function synthesizeExecute(_id: any, params: any, signal: any) {
    if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;
    const pooled: Episode[] = [];
    for (const q of params.cues) {
      const hits = [...episodes.values()]
        .map((e) => ({ e, s: decayScore(scoreEpisode(e, q) + (e.tags?.some(t=> params.cues.join(" ").toLowerCase().includes(t.toLowerCase())) ? TAG_BOOST : 0), e.ts) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 2)
        .map((x) => x.e);
      pooled.push(...hits);
    }
    const unique = [...new Map(pooled.map((e) => [e.id, e])).values()].slice(0, 5);
    const recentThink = deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n");
    if (!unique.length && !recentThink) return { content: [{ type: "text", text: "No episodes found for cues. Use remember first." }], details: { episodes: [] } };
    const thinkGoal = (deliberations[deliberations.length-1] as any)?.goal ?? "";
    const raw = params.prompt?.trim();
    const isLoose = !raw || raw.length < 15 || /^creative approach/i.test(raw);
    const synthesisPrompt = isLoose
      ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Synthesize a novel approach combining: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
      : raw;
    const sources = unique.length ? `Sources:\n${unique.map((e) => `[${e.cue}]${e.tags?.length?` {${e.tags.join(",")}}`:""} ${e.summary}${e.detail ? ` — ${e.detail.slice(0,80)}` : ""}`).join("\n")}` : "";
    const deliberationBlock = recentThink ? `Deliberation:\n${recentThink}` : "";
    const context = [sources, deliberationBlock].filter(Boolean).join("\n\n");
    const text = `${synthesisPrompt}\n\n${context}\n\n→ Combine insights: fuse episode patterns WITH deliberation hypotheses into variant not in either source.`;
    return { content: [{ type: "text", text: truncate(text) }], details: { episodes: unique, cues: params.cues, deliberation: recentThink || undefined } };
  }
  pi.registerTool({
    name: "combine",
    label: "Combine",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach. Alias: synthesize. Prompt e.g. 'synthesize neon + login into glass login' NOT vague 'creative approach' (loose auto-enriched). No vector DB.",
    parameters: synthesizeParams,
    async execute(_id, params, signal) { return synthesizeExecute(_id, params, signal); },
  });
  pi.registerTool({
    name: "synthesize",
    label: "Synthesize",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach (clear alias for combine). Prompt e.g. 'synthesize neon + login into glass login' (loose auto-enriched). No vector DB.",
    parameters: synthesizeParams,
    async execute(_id, params, signal) { return synthesizeExecute(_id, params, signal); },
  });

  pi.registerTool({
    name: "plan",
    label: "Plan",
    description: "Create/update ordered tasklist after think (+ synthesize/combine if novel). Use after think/synthesize, before write. Tasks shown as [ ]/[x]. Pass id+done to mark complete. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Plan goal (e.g. creative login page)" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Ordered tasks", minItems: 1, maxItems: 10 })),
      id: Type.Optional(Type.String({ description: "Existing plan id to update" })),
      done: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { description: "Indices to mark done (0-based)" })),
      hypotheses: Type.Optional(Type.Array(Type.String(), { description: "Optional hypotheses for single-shot think+plan (creates deliberation)" })),
    }),
    async execute(_id, params: any, _signal) {
      // S05 single-shot: hypotheses present → create deliberation and satisfy think gate
      if (params.hypotheses?.length && !thinkSatisfied) {
        const entry = { goal: truncate(params.goal ?? "plan deliberation"), hypotheses: params.hypotheses.map(truncate), ts: Date.now() };
        deliberations.push(entry as any);
        if (deliberations.length > 10) deliberations.shift();
        thinkSatisfied = true;
        if (needsDebugThink) { needsDebugThink = false; needsPlanUpdate = true; }
        (pi as any).events?.emit?.("brain:deliberation", entry);
      }
      if (needsDebugThink && !params.hypotheses?.length && (!params.goal || !String(params.goal).toLowerCase().startsWith("debug"))) {
        // allow plan update only after debug think, but don't block plan creation if hypotheses provided
      }
      if (params.id && plans.has(params.id)) {
        const pl = plans.get(params.id)!;
        if (params.done?.length) for (const i of params.done) if (pl.tasks[i]) pl.tasks[i].done = true;
        if (params.tasks?.length) {
          const existing = new Set(pl.tasks.map(t=>t.title.trim().toLowerCase()));
          for (const t of params.tasks) {
            const norm = t.trim().toLowerCase();
            if (!existing.has(norm)) { pl.tasks.push({ title: truncate(t), done: false }); existing.add(norm); }
          }
        }
        if (params.goal) pl.goal = truncate(params.goal);
        pl.ts = Date.now();
        cachedLatestPlan = pl;
        needsPlanUpdate = false;
        await (pi as any).appendEntry?.("brain:plan", pl);
        const text = renderPlan(pl) + `\n(id: ${pl.id})`;
        return { content: [{ type: "text", text: truncate(text) }], details: { plan: pl } };
      }
      if (!params.goal || !params.tasks?.length) return { content: [{ type: "text", text: "plan: goal and tasks required for new plan (use id+done to update)" }], details: { error: "missing goal/tasks" } } as any;
      if (params.hypotheses?.length && params.hypotheses.length < 1) return { content: [{ type: "text", text: "hypotheses must have 1-3 items" }], details: { error: "bad hypotheses" } } as any;
      const pl: Plan = {
        id: `brain-plan:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        goal: truncate(params.goal),
        tasks: params.tasks.map((t: string) => ({ title: truncate(t), done: false })),
        ts: Date.now(),
      };
      if (params.done?.length) for (const i of params.done) if (pl.tasks[i]) pl.tasks[i].done = true;
      plans.set(pl.id, pl);
      cachedLatestPlan = pl;
      needsPlanUpdate = false;
      await (pi as any).appendEntry?.("brain:plan", pl);
      (pi as any).events?.emit?.("brain:plan", pl);
      const text = renderPlan(pl) + `\n(id: ${pl.id})`;
      return { content: [{ type: "text", text: truncate(text) }], details: { plan: pl } };
    },
  });

  pi.registerTool({
    name: "habit",
    label: "Habit",
    description: "Create a SKILL.md scaffold for a repeated correction (cerebellum habit automatization). Draft only. Use variant mutate for creative alternative.",
    parameters: Type.Object({
      name: Type.String({ description: "Habit name (kebab-case)" }),
      when: Type.String({ description: "When to use this habit" }),
      steps: Type.String({ description: "Steps to follow" }),
      variant: Type.Optional(Type.String({ description: "Optional mutate: add creative alternative steps" })),
    }),
    async execute(_id, params, signal, _upd, ctx: any) {
      const cwd: string = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
      const safe = params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!safe) return { content: [{ type: "text", text: "Invalid habit name" }], details: { error: "empty name" } } as any;
      if (ctx?.isProjectTrusted?.() === false) return { content: [{ type: "text", text: "Project not trusted — habit blocked" }], details: { error: "untrusted" } } as any;
      const dir = `${cwd}/.pi/skills/brain-${safe}`;
      const file = `${dir}/SKILL.md`;
      const alt = params.variant ? `\n\n## Alternative (mutate)\n\n${params.variant}\n` : "";
      const body = `---\nname: brain-${safe}\ndescription: ${params.when.replace(/---/g,"—").replace(/\n/g," ").slice(0,120)}\n---\n\n# ${params.name}\n\n${params.steps}${alt}\n`;
      try {
        const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
        if (signal?.aborted) throw new Error("aborted");
        if (existsSync(file) && !habitPending.has(safe)) {
          const prev = readFileSync(file, "utf8").slice(0, 400);
          habitPending.add(safe);
          return { content: [{ type: "text", text: `Preview: ${file} already exists.\n--- existing (first 400 chars) ---\n${prev}\n---\nSanitized: brain-${safe}\nWill overwrite on next call with same name. Undo: rm -r ${dir}` }], details: { skillPath: dir, sanitized: `brain-${safe}`, preview: prev, needsConfirm: true } };
        }
        habitPending.delete(safe);
        mkdirSync(dir, { recursive: true });
        if ((pi as any).withFileMutationQueue) await (pi as any).withFileMutationQueue(file, async () => { writeFileSync(file, body, "utf8"); });
        else writeFileSync(file, body, "utf8");
      } catch (e: any) {
        if (String(e.message).includes("Preview")) throw e;
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], details: { error: String(e) } };
      }
      return { content: [{ type: "text", text: `Drafted ${file}${params.variant ? " + variant" : ""}\nSanitized: brain-${safe}\nUndo: rm -r ${dir}` }], details: { skillPath: dir, sanitized: `brain-${safe}` } };
    },
  });

  pi.registerCommand("pi-brain", {
    description: "Toggle strict brain mode: /pi-brain on (answer only from brain) | /pi-brain off (default pi) | /pi-brain status",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["on", "off", "status"];
      const f = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return f.length ? f.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const persist = async (enabled: boolean) => {
        brainStrict = enabled;
        thinkSatisfied = false;
        needsDebugThink = false;
        needsPlanUpdate = false;
        hasWriteEdit = false;
        hasRemember = false;
        await (pi as any).appendEntry?.("brain:mode", { enabled, ts: Date.now() });
        try { (pi as any)._brainStrict = enabled; ctx?.ui?.setStatus?.("brain", enabled ? "brain: strict" : "brain: default"); } catch {}
        (pi as any).events?.emit?.("brain:mode", { enabled });
      };
      if (arg === "on" || arg === "enable" || arg === "strict") {
        await persist(true);
        ctx.ui.notify("pi-brain: ON — all queries answered strictly from brain episodes (recall-only). Use /pi-brain off to restore default.", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "default") {
        await persist(false);
        ctx.ui.notify("pi-brain: OFF — default pi behavior restored.", "info");
        return;
      }
      if (arg === "status" || arg === "") {
        let usage: any = undefined;
        try { usage = ctx?.getContextUsage?.() ?? undefined; } catch {}
        const pct = usage?.percent ?? (usage?.used && usage?.total ? Math.round((usage.used/usage.total)*100) : undefined);
        const overloaded = (pct !== undefined && pct > 80) || episodes.size > 50;
        const latestPlan = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
        if (latestPlan) cachedLatestPlan = latestPlan;
        const planStr = latestPlan ? `${latestPlan.goal}: ${latestPlan.tasks.filter(t=>t.done).length}/${latestPlan.tasks.length} done` : "no plan";
        const recentCues = [...episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map(e=>e.cue).join(", ") || "—";
        const tbl = `pi-brain: ${brainStrict ? "ON (strict)" : "OFF (default)"}\nEpisodes: ${episodes.size} | Deliberations: ${deliberations.length} | Plan: ${planStr}\nTokens: ${usage?.used ?? "?"} / ${usage?.total ?? "?"}${pct !== undefined ? ` (${pct}%)` : ""}${overloaded ? " [overload]" : ""}\nRecent: ${recentCues}\nIndex: ${tokenIndex.size} tokens, ${tagIndex.size} tags\nUsage: /pi-brain on | /pi-brain off`;
        ctx.ui.notify(tbl, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain on | /pi-brain off | /pi-brain status`, "warning");
    },
  });

  pi.on("input" as any, async (ev: any) => {
    if (typeof ev?.text === "string" && ev.text.startsWith("@")) {
      if (ev.text.length === 1) return { action: "continue" } as any;
      return { action: "transform", text: ev.text.slice(1) } as any;
    }
    return { action: "continue" } as any;
  });

  pi.on("before_agent_start" as any, async (ev: any) => {
    thinkSatisfied = false;
    hasWriteEdit = false;
    hasRemember = false;
    needsDebugThink = false;
    needsPlanUpdate = false;
    if (brainStrict) {
      const query: string = ev?.prompt ?? "";
      const all = [...episodes.values()];
      const scored = all
        .map((e) => ({ e, s: decayScore(scoreEpisode(e, query) + (e.tags?.length ? 0 : 0), e.ts) }))
        .filter((x) => x.s > 0 || query.trim() === "")
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts);
      const maxScore = scored.length ? scored[0].s : 0;
      // S04 relevance gate: if maxScore==0 inject ≤1 else up to 5; S11 trace
      const injectCount = maxScore === 0 ? 1 : Math.min(STRICT_INJECT_MAX, scored.length || 1);
      const top = scored.length ? scored.slice(0, injectCount).map((x) => x.e) : all.sort((a, b) => b.ts - a.ts).slice(0, 1);
      const ranked = top.length ? top : all.sort((a, b) => b.ts - a.ts).slice(0, 1);
      const context = ranked.length
        ? ranked.map((e) => `[${e.cue}]${e.tags?.length?` {${e.tags.join(",")}}`:""} ${e.summary}${e.detail ? " — " + e.detail.slice(0, 160) : ""}${e.refs?.length?` refs:${e.refs.join(",")}`:""}`).join("\n")
        : "(no episodes yet — brain is empty)";
      const trace = `[brain: ${ranked.length} episodes, maxScore ${maxScore.toFixed(1)}]`;
      const strictInstruction = `[STRICT BRAIN MODE ON — 7 RULES ENFORCED]\nHappy: recall → think → [synthesize/combine if novel] → plan → execute(read→edit 1 file→bash) → plan.done → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')\nUnhappy: same flow, but on ANY failure (read/edit/write/bash error, non-zero exit) you MUST call think{goal:"debug <failed Task N>", hypotheses:[root cause, fix approach]} before retry, then update plan{id,done} and retry. Execution is blocked until debug-think is done.\n\n1. Recall-first: answer ONLY from episodes below. Cite cue(s). If none relevant → "No relevant brain episode — try /pi-brain off or add with remember."\n2. Think-before-act: you MUST call think{goal,hypotheses} before any write/edit (enforced — write will be blocked otherwise).\n3. Combine-only-for-novelty: call synthesize/combine when task is creative/novel (e.g. "creative login", "novel approach"), SKIP for CRUD/bugfix — do this BEFORE planning to get all inputs.\n4. Plan-after-inputs: after think (+ synthesize/combine if used), call plan{goal,tasks[]} to create [ ] checklist, then mark [x] via plan{id,done} as you execute.\n5. Shortest-diff: read target first, edit ONE file, bash verify, no scaffolding for later.\n6. Encode: after every successful write/edit/bash you MUST call remember{cue,summary}; 2nd repeat of same fix → habit{name,when,steps}.\n7. Git: when plan 2/2 done + remember done, bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>' (skip if no changes).\n\nBrain episodes for query "${query.slice(0, 120)}" ${trace}:\n${context}`;
      const latestPlan = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
      if (latestPlan) cachedLatestPlan = latestPlan;
      const planBlock = latestPlan ? `\n\nActive plan:\n${renderPlan(latestPlan)}\n(id: ${latestPlan.id})` : "";
      const strictWithPlan = strictInstruction + planBlock;
      const sys = typeof ev?.systemPrompt === "string" ? ev.systemPrompt + "\n\n" + strictWithPlan : strictWithPlan;
      return { systemPrompt: sys } as any;
    }
    // default mode: relevance-gated light inject (S04+S11)
    const prompt: string = ev?.prompt ?? "";
    const all = [...episodes.values()];
    let scored: { e: Episode; s: number }[] = [];
    if (prompt.trim() && all.length) {
      scored = all.map((e) => ({ e, s: decayScore(scoreEpisode(e, prompt), e.ts) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts);
    }
    const maxScore = scored.length ? scored[0].s : 0;
    const recent = all.sort((a, b) => b.ts - a.ts);
    const toInject = maxScore === 0
      ? recent.slice(0, DEFAULT_INJECT_COUNT)
      : scored.slice(0, DEFAULT_INJECT_SCORED).map((x) => x.e);
    const recentThink = deliberations.slice(-2);
    const latestPlanDef = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
    if (latestPlanDef) cachedLatestPlan = latestPlanDef;
    if (!toInject.length && !recentThink.length && !latestPlanDef) return;
    const parts: string[] = [];
    if (toInject.length) parts.push(`Recent brain episodes [maxScore ${maxScore.toFixed(1)}]:\n${toInject.map((e) => `- ${e.cue}${e.tags?.length?` {${e.tags.join(",")}}`:""}: ${e.summary}`).join("\n")}`);
    if (recentThink.length) parts.push(`Recent deliberations:\n${recentThink.map((d: any) => `- ${d.goal}: ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n")}`);
    if (latestPlanDef) parts.push(`Active plan:\n${renderPlan(latestPlanDef)}\n(id: ${latestPlanDef.id})`);
    return { message: { role: "system", content: parts.join("\n\n") } } as any;
  });

  pi.on("context" as any, async (ev: any) => {
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    if (msgs.length > 40) {
      const sys = msgs.filter((m: any) => m.role === "system").slice(0, 1);
      const tail = msgs.slice(-20);
      return { messages: [...sys, ...tail] } as any;
    }
  });

  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      const cue = `${ev.toolName}:${(ev.input?.path ?? "").toString().slice(0, 30)}`;
      const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
      if (summary) {
        const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto" };
        await (pi as any).appendEntry?.("brain:episode", ep);
        episodes.set(ep.id, ep);
        indexEpisode(ep);
        hasWriteEdit = true;
      }
    } else if (ev?.toolName === "bash" && !ev?.isError) {
      const cmd: string = (ev.input?.command ?? "").toString();
      const isMutating = /\b(mkdir|rm|mv|cp|touch|install|chmod|chown)\b/.test(cmd) || (cmd.includes(">") && !cmd.includes("/dev/null") && !cmd.includes("2>&1") && /[>]\s*[^\s|&;]+/.test(cmd)) || /\b(write|edit)\b/i.test(cmd);
      if (isMutating) {
        const cue = `bash:${cmd.slice(0,30)}`;
        const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
        if (summary) {
          const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto" };
          await (pi as any).appendEntry?.("brain:episode", ep);
          episodes.set(ep.id, ep);
          indexEpisode(ep);
          hasWriteEdit = true;
        }
      }
    }
    if ((ev?.toolName === "remember" || ev?.toolName === "habit") && !ev?.isError) hasRemember = true;
    if (ev?.isError) {
      lastFailedTool = ev.toolName ?? "unknown";
      lastErrorSnippet = (ev.content?.[0]?.text ?? ev.error ?? "").toString().slice(0, 80);
      needsDebugThink = true;
      needsPlanUpdate = false;
      thinkSatisfied = false;
      try { (ctx as any)?.ui?.notify?.(`Strict unhappy path: ${lastFailedTool} failed — call think{goal:'debug Task N — ${lastFailedTool}: ${lastErrorSnippet}', hypotheses:[cause,fix]} before retry.`, "warning"); } catch {}
      const hint = `\n[ brain: ${lastFailedTool} failed — call think{goal:'debug <failed Task N> — ${lastFailedTool}: ${lastErrorSnippet}', hypotheses:[root cause, fix]} then plan{id,done} before retry ]`;
      const cur = ev.content?.[0]?.text ?? "";
      return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
    }
  });

  pi.on("session_before_compact" as any, async (ev: any) => {
    const all = [...episodes.values()].sort((a, b) => b.ts - a.ts);
    // S12 compact budget: <15 → 3 else 5; overload keeps 5
    const budget = all.length < 15 ? COMPACT_SMALL : COMPACT_LARGE;
    // overload always 5
    let pct: number | undefined;
    try { const u: any = (pi as any)._ctx?.getContextUsage?.() ?? undefined; if (u?.percent) pct = u.percent; } catch {}
    const overloaded = (pct !== undefined && pct > 80) || all.length > 50;
    const n = overloaded ? COMPACT_LARGE : budget;
    const ranked = all.slice(0, n);
    if (!ranked.length) return;
    const brain = `Brain episodes:\n${ranked.map((e) => `- ${e.cue}${e.tags?.length?` {${e.tags.join(",")}}`:""}: ${e.summary}`).join("\n")}`;
    const summary = ev?.summary ? `${brain}\n\n${ev.summary}` : brain;
    return { summary } as any;
  });

  pi.on("resources_discover" as any, async (ev: any) => {
    return { skillPaths: ev?.skillPaths ?? [] } as any;
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    if (ev?.toolName === "bash") {
      const cmd: string = ev?.input?.command ?? "";
      const low = cmd.toLowerCase();
      const isRmRf = /\brm\b/.test(low) && (/\s-[a-z]*r[a-z]*f/.test(low) || (low.includes("--recursive") && low.includes("--force")));
      if (isRmRf) {
        if (!ctx?.hasUI) return { block: true, reason: "Blocked by brain guard: rm -rf needs UI confirm" } as any;
        try {
          const ok = await ctx.ui.confirm("Dangerous", "Allow rm -rf?");
          if (!ok) return { block: true, reason: "Blocked by brain guard" } as any;
        } catch {
          return { block: true, reason: "Blocked by brain guard" } as any;
        }
      }
    }
    if (brainStrict && needsDebugThink && ["write", "edit", "bash"].includes(ev?.toolName)) {
      const tmpl = `think{goal:"debug <failed Task N> — ${lastFailedTool}: ${lastErrorSnippet}", hypotheses:["cause guess","fix guess"]}`;
      return { block: true, reason: `Blocked by strict unhappy path: ${lastFailedTool} failed — call ${tmpl} before retry.` } as any;
    }
    if (brainStrict && needsPlanUpdate && ["write", "edit", "bash"].includes(ev?.toolName)) {
      const pid = cachedLatestPlan?.id ?? "<plan-id>";
      return { block: true, reason: `Blocked by strict unhappy path: debug think done — now update plan{id:"${pid}", done:[N]} before retry.` } as any;
    }
    if (brainStrict && (ev?.toolName === "write" || ev?.toolName === "edit")) {
      if (!thinkSatisfied) {
        return { block: true, reason: "Blocked by strict workflow Rule 2: call think{goal,hypotheses} before write/edit. Deliberate 2-3 approaches first." } as any;
      }
    }
  });

  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    if (brainStrict && hasWriteEdit && !hasRemember) {
      try { ctx?.ui?.notify?.("Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
      // S07 plan auto-link: when all done + hasWriteEdit + !hasRemember, surface prefilled template
      const latest = cachedLatestPlan;
      if (latest && latest.tasks.length && latest.tasks.every((t) => t.done)) {
        const kebab = latest.goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "plan-done";
        const lastSummary = [...episodes.values()].sort((a,b)=>b.ts-a.ts)[0]?.summary.slice(0,80) ?? latest.goal.slice(0,80);
        try { ctx?.ui?.notify?.(`Plan done — remember template: remember{cue:"${kebab}", summary:"${lastSummary}", tags:["from-plan"]}`, "info"); } catch {}
        // return hint for LLM as well (some hosts surface turn_end return)
        return { message: { role: "system", content: `Plan "${latest.goal}" complete — encode it: remember{cue:"${kebab}", summary:"${lastSummary}", tags:["from-plan"]}` } } as any;
      }
    }
  });
  pi.on("agent_end" as any, async (_ev: any, ctx: any) => {
    if (brainStrict && hasWriteEdit && !hasRemember) {
      try { ctx?.ui?.notify?.("Strict Rule 5: agent ended with unencoded changes — call remember now.", "warning"); } catch {}
    }
    hasWriteEdit = false;
  });

  pi.on("before_provider_request" as any, async (ev: any) => {
    try {
      const req = ev?.request ?? ev?.payload ?? ev;
      const msgs = req?.messages ?? req?.payload?.messages ?? ev?.messages;
      if (Array.isArray(msgs)) {
        // S13 dedup consecutive duplicate episode blocks
        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const m of msgs) {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
          if (c.includes("Recent brain episodes")) {
            if (seen.has(c)) continue;
            // keep last duplicate, drop earlier — so we scan reverse then filter
            seen.add(c);
          }
          deduped.push(m);
        }
        // if dedup removed duplicates, keep only last occurrence: reverse dedup
        // simpler: keep last occurrence by rebuilding with seen from end
        if (deduped.length !== msgs.length) {
          const keep = new Set<string>();
          const reversed: any[] = [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            if (c.includes("Recent brain episodes")) {
              if (keep.has(c)) continue;
              keep.add(c);
            }
            reversed.push(m);
          }
          reversed.reverse();
          if (req.messages) req.messages = JSON.stringify(reversed).length > 30*1024 ? (()=>{ const sys = reversed.filter((m:any)=>m.role==="system").slice(0,1); const tail = reversed.slice(-25); return [...sys, ...tail]; })() : reversed;
          else if (req.payload?.messages) req.payload.messages = reversed;
          return;
        }
        if (JSON.stringify(msgs).length > 30 * 1024) {
          const sys = msgs.filter((m: any) => m.role === "system").slice(0, 1);
          const tail = msgs.slice(-25);
          const trimmed = [...sys, ...tail];
          if (req.messages) req.messages = trimmed;
          else if (req.payload?.messages) req.payload.messages = trimmed;
        }
      }
    } catch {}
  });

  pi.on("session_shutdown" as any, async () => {});
}

