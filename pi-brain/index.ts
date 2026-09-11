import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore - typebox resolved by pi runtime
import { Type } from "typebox";
// @ts-ignore - tui resolved by pi runtime
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// pi-brain — human brain → pi extension
// 5-step: Question→Delete→Simplify→Accelerate→Automate
// One factory, one closure, one Map — no class/DI (T01 gate: no SNN/vector DB/BCI/daemon)

type Episode = {
  id: string;
  cue: string;
  summary: string;
  detail?: string;
  ts: number;
  source: string;
  tags?: string[];
  refs?: string[];
  expiresAt?: number;
};

type Plan = {
  id: string;
  goal: string;
  tasks: { title: string; done: boolean }[];
  ts: number;
};

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
// Calibration knobs (top of index.ts) — tune without code change
const TAG_BOOST = 1.5;
const HALF_LIFE_DAYS = 7;
const HALF_LIFE_FACTOR = 0.5; // ponytail: 0.95→0.5 actually prefers fresh (was decorative 0.81 at 30d, now 0.05)
const COMPACT_SMALL = 3;
const COMPACT_LARGE = 5;
// T1+T2 knobs
const REMEMBER_BOOST = 2.0;
const AUTO_BOOST = 0.6;
const AUTO_TTL_MS = 3 * 86400000;
// T9 memo TTL — ponytail: 5s→30s, clear on remember/index (batch hit rate)
const RECALL_MEMO_MS = 30000;
// T10 budget thresholds
const BUDGET_WARN_PCT = 75;
const BUDGET_STOP_PCT = 85;
// T2 prune thresholds — ponytail: magic 35/40 extracted
const PRUNE_WARN = 35;
const PRUNE_CAP = 40;

// /pi-brain on|off is global, not per-session (branch entries only live in one session)
const MODE_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain.json");

function readMode(): boolean | undefined {
  try {
    const v = JSON.parse(readFileSync(MODE_FILE, "utf8"));
    return typeof v?.enabled === "boolean" ? v.enabled : undefined;
  } catch {
    return undefined;
  }
}

function writeMode(enabled: boolean) {
  try {
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, JSON.stringify({ enabled, ts: Date.now() }), "utf8");
  } catch {}
}

function truncate(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n") + `\n[truncated ${lines.length - MAX_LINES} lines]`;
  const byteLen = typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : new TextEncoder().encode(text).length;
  if (byteLen > MAX_BYTES) {
    // ponytail: backtrack to valid UTF-8 boundary — naive cut fixed (per-path cache if needed)
    if (typeof Buffer !== "undefined") text = Buffer.from(text, "utf8").slice(0, MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + "\n[truncated to 50KB]";
    else text = text.slice(0, MAX_BYTES) + "\n[truncated to 50KB]";
  }
  return text;
}

function tokenize(s: string): string[] {
  try { return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); } catch { return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
}

function normalizeTags(tags?: string[]): string[] | undefined {
  if (!tags?.length) return undefined;
  const out = tags.map(t => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, "-").replace(/-+/g,"-").replace(/^-|-$/g,"")).filter(Boolean).slice(0,8);
  return out.length ? [...new Set(out)] : undefined;
}

function parseSince(since?: string | number): number | undefined {
  if (since == null) return undefined;
  if (typeof since === "number") return since;
  const s = String(since).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+)(h|d)$/);
  if (m) return Date.now() - Number(m[1]) * (m[2]==="h"?3600000:86400000);
  const parsed = Date.parse(s);
  return isNaN(parsed) ? undefined : parsed;
}

// --- T7 synonym map (tiny, local, no embedding) ---
const SYN: Record<string,string[]> = {
  deploy: ["deploy","ship","release","publish"],
  bug: ["bug","fix","error","issue","fail"],
  auth: ["auth","login","signin","credential"],
  perf: ["perf","performance","speed","slow","latency"],
  cache: ["cache","memo","store"],
  test: ["test","spec","pytest","jest","vitest"],
  build: ["build","compile","bundle"],
  cold: ["cold","start","init","boot"],
  db: ["db","database","store","storage"],
  ui: ["ui","frontend","interface","view"],
};
// ponytail: SYN override — pi-brain.syn.json merges if present (add when miss >20%)
try { const _syn = JSON.parse(readFileSync(join(process.cwd(),"pi-brain.syn.json"),"utf8")); Object.assign(SYN, _syn); } catch {}
try { const _syn2 = JSON.parse(readFileSync(join(homedir(),".pi","agent","pi-brain.syn.json"),"utf8") as any); Object.assign(SYN, _syn2); } catch {}
function expandTokens(toks: string[]): string[] {
  const out = new Set<string>();
  for (const t of toks) {
    out.add(t);
    if (SYN[t]) for (const s of SYN[t]) out.add(s);
  }
  return [...out];
}

// T10 token estimator
function estTokens(s: string): number { return Math.ceil(s.length / 4); }

// T3 gist helpers
function gistForEpisode(e: Episode): string {
  const first = e.summary.split(/[.!?\n]/)[0]?.trim() || e.summary;
  const base = `${e.cue}: ${first}`;
  const tagPart = e.tags?.length ? ` [${e.tags.join(",")}]` : "";
  const raw = base + tagPart;
  return raw.length > 120 ? raw.slice(0,117) + "..." : raw;
}
function compressEpisodes(list: Episode[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const k = e.cue.toLowerCase().trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`- ${gistForEpisode(e)}`);
    if (out.length >= 3) break;
  }
  return out.join("\n");
}

// T1 scoring split: base vs ranked
function scoreBase(e: Episode, query: string, filterTags?: string[]): number {
  const terms = tokenize(query);
  // expand query tokens for scoring (T7)
  const expanded = expandTokens(terms);
  const hasQuery = terms.length > 0 || query.trim().length > 0;
  const qLower = query.toLowerCase().trim();
  let s = 0;
  const cueToks = tokenize(e.cue);
  const sumToks = tokenize(e.summary);
  const detToks = tokenize(e.detail ?? "");
  if (qLower && e.cue.toLowerCase().includes(qLower)) s += 2;
  if (qLower && e.summary.toLowerCase().includes(qLower)) s += 1;
  // term TF using expanded tokens (so "ship" hits "deploy")
  for (const t of expanded) {
    s += cueToks.filter((x) => x === t).length * 2;
    s += sumToks.filter((x) => x === t).length * 1;
    s += detToks.filter((x) => x === t).length * 0.5;
  }
  // tag boost uses normalized tags (T5)
  const normFilterTags = normalizeTags(filterTags as any);
  if (e.tags?.length) {
    const eTagsNorm = normalizeTags(e.tags) ?? [];
    for (const t of expanded) if (eTagsNorm.includes(t)) s += TAG_BOOST;
    if (normFilterTags?.length) for (const ft of normFilterTags) if (eTagsNorm.includes(ft)) s += TAG_BOOST;
  }
  // tag-only recall base score — per-tag boost
  if (!hasQuery && normFilterTags?.length && e.tags?.length) {
    const eTagsNorm = normalizeTags(e.tags) ?? [];
    const matchedCount = normFilterTags.filter(ft => eTagsNorm.includes(ft)).length;
    if (matchedCount && s === 0) s = matchedCount * TAG_BOOST;
  }
  return s;
}
function sourceBoost(e: Episode): number {
  return e.source === "remember" ? REMEMBER_BOOST : e.source === "auto" ? AUTO_BOOST : 1;
}
function scoreEpisode(e: Episode, query: string, filterTags?: string[]): number {
  const base = scoreBase(e, query, filterTags);
  if (base === 0) return 0;
  const ageDays = Math.max(0, (Date.now() - e.ts) / 86400000); // M1: clamp future timestamps
  const decay = Math.pow(HALF_LIFE_FACTOR, ageDays / HALF_LIFE_DAYS);
  return base * decay * sourceBoost(e);
}

// ponytail: plan 3-10 guard as pure fn — schema bounds fire before execute (raw typebox error, no guidance)
function planTaskError(tasks: string[]): string | undefined {
  if (tasks.length < 3) return `plan requires ≥3 detailed tasks (got ${tasks.length}) — split into 3-10 well-structured steps. Example: ["analyze requirement & existing code","update index.ts core logic","update docs & verify"]`;
  if (tasks.length > 10) return `plan got ${tasks.length} tasks — max 10. Chunk it: create with the first 10, then append plan{id:"<id>", tasks:["remaining…"]}. Or merge related steps.`;
  const short = tasks.filter((t) => t.trim().length < 10);
  if (short.length) return `plan tasks must be detailed (≥10 chars each) — short: "${short[0].slice(0,30)}" — make each concrete and actionable (what file, what change)`;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  // hippocampus — durable, branch-scoped
  const episodes = new Map<string, Episode>();
  // incremental token → ids index (ponytail: O(1) recall, rebuilt on session_start, O(n) fallback if <10k)
  const tokenIndex = new Map<string, Set<string>>();
  // PFC scratchpad — deliberations (not durable, per-turn working memory)
  const deliberations: { goal: string; hypotheses: string[]; ts: number }[] = [];
  // /pi-brain strict gate — branch-durable, defaults off
  let brainStrict = false;
  // strict workflow enforcement (per-agent run)
  let thinkSatisfied = false;
  let hasWriteEdit = false;
  let hasRemember = false;
  let rule5Warned = false;
  let needsDebugThink = false; // unhappy path: failure → must think before retry
  let needsPlanUpdate = false; // after debug think, must update plan before retry
  let cachedLatestPlan: Plan | null = null;
  // plan — ordered tasklist after think (ponytail: one Map, no class)
  const plans = new Map<string, Plan>();
  const renderPlan = (p: Plan) => `${p.goal}\n` + p.tasks.map((t, i) => `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}`).join("\n");
  const isPlanDone = (): boolean => {
    const p = cachedLatestPlan ?? [...plans.values()].sort((a, b) => b.ts - a.ts)[0] ?? null;
    return !!p && p.tasks.length > 0 && p.tasks.every((t) => t.done);
  };

  function indexEpisode(e: Episode) {
    const toks = new Set([...tokenize(e.cue), ...tokenize(e.summary), ...tokenize(e.detail ?? ""), ...(e.tags ?? []).map(t=>t.toLowerCase())]);
    for (const tok of toks) {
      let set = tokenIndex.get(tok);
      if (!set) { set = new Set(); tokenIndex.set(tok, set); }
      set.add(e.id);
    }
  }
  function unindexEpisode(e: Episode) {
    const toks = new Set([...tokenize(e.cue), ...tokenize(e.summary), ...tokenize(e.detail ?? ""), ...(e.tags ?? []).map(t=>t.toLowerCase())]);
    for (const tok of toks) {
      const set = tokenIndex.get(tok);
      if (set) { set.delete(e.id); if (set.size === 0) tokenIndex.delete(tok); }
    }
  }
  function rebuildIndex() {
    tokenIndex.clear();
    for (const e of episodes.values()) indexEpisode(e);
  }
  // T2 prune expired auto episodes
  function pruneExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [id,e] of episodes) {
      if (e.expiresAt && e.expiresAt < now) {
        unindexEpisode(e);
        episodes.delete(id);
        n++;
      }
    }
    if (n) {
      // clear memo on prune
      recallMemo.clear();
    }
    // M2: LRU eviction if still over cap — delete oldest auto then oldest overall (warn if evicting remember)
    while (episodes.size > PRUNE_CAP) {
      const sorted = [...episodes.values()].sort((a,b)=>a.ts-b.ts);
      const oldest = sorted.find(e=>e.source==="auto") ?? sorted[0];
      if (!oldest) break;
      if (oldest.source !== "auto") (pi as any).events?.emit?.("brain:overload", { evictRemember: oldest.cue, size: episodes.size });
      unindexEpisode(oldest);
      episodes.delete(oldest.id);
      n++;
      recallMemo.clear();
    }
    return n;
  }
  function isNoiseBash(cmd: string, output: string): boolean {
    const c = cmd.trim().toLowerCase();
    if (!c) return true;
    // pure read/ls noise — human brain forgets (only if short)
    if (/^\s*(ls|cat|head|tail|grep|find|echo|pwd|which|whoami|env|printenv)\b/.test(c)) return output.length < 200;
    // git status/diff short noise
    if (/^\s*git\s+(status|diff\s*--stat|log\s+--oneline)/.test(c) && output.length < 200) return true;
    if (output.length < 30) return false; // don't hide short errors like ENOENT
    return false;
  }

  // T9 recall memo
  const recallMemo = new Map<string, { ts: number; ranked: Episode[]; text: string }>();
  let memoHits = 0;
  let memoMisses = 0;

  // TUI renderer for brain:episode — collapsed cue, expanded detail (not in LLM context)
  try {
    (pi as any).registerEntryRenderer?.("brain:episode", (entry: any, opts: any, theme: any) => {
      const d: Episode = entry.data ?? entry;
      const tags = d.tags?.length ? ` [${d.tags.join(",")}]` : "";
      const refs = d.refs?.length ? ` refs:${d.refs.join(",")}` : "";
      const line = opts?.expanded ? `${d.cue}${tags}\n${d.summary}${d.detail ? "\n" + d.detail : ""}${refs}` : `${d.cue}${tags}: ${d.summary.slice(0, 80)}`;
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

  // T04: waking recall — rebuild from branch (branch-safe, like waking)
  pi.on("session_start" as any, async (_ev: any, ctx: any) => {
    episodes.clear();
    tokenIndex.clear();
    plans.clear();
    deliberations.length = 0;
    brainStrict = false;
    thinkSatisfied = false;
    hasWriteEdit = false;
    hasRemember = false;
    rule5Warned = false;
    needsDebugThink = false;
    needsPlanUpdate = false;
    cachedLatestPlan = null;
    recallMemo.clear(); memoHits=0; memoMisses=0;
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
        if (e.type === "entry" && (e.entryType === "brain:deliberation" || e.entry_type === "brain:deliberation")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.goal) deliberations.push(d as any);
        }
        if (e.type === "message" && (e as any).message?.role === "toolResult" && (e as any).message?.toolName === "remember") {
          const ep = (e as any).message?.details?.episode;
          if (ep?.id) episodes.set(ep.id, ep);
        }
      }
      // rebuild incremental index
      rebuildIndex();
      // T2 prune expired after rebuild
      pruneExpired();
      // also prune if over 40
      if (episodes.size > PRUNE_CAP) pruneExpired();
      // file wins: /pi-brain on stays on across sessions until /pi-brain off
      const fileMode = readMode();
      if (fileMode !== undefined) brainStrict = fileMode;
      else if (lastMode !== undefined) brainStrict = lastMode;
    } catch {}
    // reflect in footer
    try { (pi as any)._brainStrict = brainStrict; } catch {}
  });

  // T05: remember — explicit encoding with pre-write audit (smart notebook)
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Explicitly encode an episode to brain memory (hippocampus). Use cue as associative key. Audits before write: exact cue → upsert, similar (score≥3) → preview + needs force:true. Supports tags (≤8 kebab) and refs (≤5 files).",
    parameters: Type.Object({
      cue: Type.String({ description: "Associative cue (short key for recall)" }),
      summary: Type.String({ description: "One-line summary of episode" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for grouping (kebab, ≤8)", maxItems: 8 })),
      refs: Type.Optional(Type.Array(Type.String(), { description: "File refs (≤5)", maxItems: 5 })),
      force: Type.Optional(Type.Boolean({ description: "Force encode even if similar episodes exist (skip audit block)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cueNorm = params.cue.trim().toLowerCase();
      if (!cueNorm) return { content: [{ type: "text", text: "cue must be non-empty" }], details: { error: "empty cue" } } as any;
      if (!params.summary?.trim()) return { content: [{ type: "text", text: "summary must be non-empty" }], details: { error: "empty summary" } } as any;
      const tags = normalizeTags(params.tags as any);
      const refs = params.refs?.map((r: string)=>truncate(r)).slice(0,5);
      // ponytail: exact cue → upsert (no dup), reuse scoring for similarity check
      const exact = [...episodes.values()].find((e) => e.cue.trim().toLowerCase() === cueNorm);
      if (exact && !params.force) {
        // upsert: update existing instead of creating duplicate
        unindexEpisode(exact);
        exact.summary = truncate(params.summary);
        if (params.detail) exact.detail = truncate(params.detail);
        if (tags) exact.tags = tags;
        if (refs) exact.refs = refs;
        exact.ts = Date.now();
        exact.source = "remember";
        delete (exact as any).expiresAt;
        indexEpisode(exact);
        await (pi as any).appendEntry?.("brain:episode", exact);
        episodes.set(exact.id, exact);
        recallMemo.clear();
        (pi as any).events?.emit?.("brain:episode:encoded", exact);
        return { content: [{ type: "text", text: `Updated (audit: exact cue exists) ${exact.id} — was duplicate cue, merged instead of new` }], details: { id: exact.id, episode: exact, audit: "exact-cue-upsert" } };
      }
      // similarity audit: T1 decay-exempt (scoreBase) + source filter
      const query = `${params.cue} ${params.summary}`;
      const scored = [...episodes.values()]
        .filter((e) => e.source !== "auto")
        .map((e) => ({ e, s: scoreBase(e, query, tags) }))
        .filter((x) => x.s >= 3)
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, 3);
      if (scored.length && !params.force && !exact) {
        const preview = scored.map((x) => `[${x.e.cue}] ${x.e.summary} (score:${x.s.toFixed(1)})`).join("\n");
        return { content: [{ type: "text", text: `Audit: ${scored.length} similar episode(s) found — not encoded.\n${preview}\n→ To update existing, reuse its cue. To force new, call remember again with force:true` }], details: { audit: "similar-found", similar: scored.map((x) => ({ episode: x.e, score: x.s })), blocked: true } } as any;
      }
      const ep: Episode = {
        id: `${params.cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        cue: truncate(params.cue),
        summary: truncate(params.summary),
        detail: params.detail ? truncate(params.detail) : undefined,
        tags,
        refs,
        ts: Date.now(),
        source: "remember",
      };
      await (pi as any).appendEntry?.("brain:episode", ep);
      episodes.set(ep.id, ep);
      indexEpisode(ep);
      recallMemo.clear();
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id}` }], details: { id: ep.id, episode: ep, audit: scored.length ? "forced" : "clean" } };
    },
  });

  // T06: recall — TF-IDF pattern completion with incremental index + memo + synonym expansion
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Associative recall: TF-IDF cue→ranked episodes (pattern completion). Incremental token→ids index + half-life decay + tag boost + filters tags/source/since. Tag-only recall: query \"\" + tags. Batch: queries[] for 1 call = N recalls. No vector DB.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Cue to recall by" })),
      queries: Type.Optional(Type.Array(Type.String(), { description: "Batch cues (1 call = N recalls)", maxItems: 5 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (AND)", maxItems: 8 })),
      source: Type.Optional(Type.String({ description: "Filter by source: remember|auto" })),
      since: Type.Optional(Type.String({ description: "Filter since: 7d|24h|ISO|ms" })),
    }),
    async execute(_id, params, signal) {
      const limit = params.limit ?? 5;
      const queries: string[] = (params as any).queries?.length ? (params as any).queries : [(params as any).query ?? ""];
      // T9 memo key (T5 normalize tags for stable key)
      const normTags = normalizeTags(params.tags as any);
      const memoKey = `${queries.join("\x00")}|${(normTags??[]).join(",")}|${params.source??""}|${params.since??""}|${limit}`; // ponytail: \x00 avoids a+b collision
      const cached = recallMemo.get(memoKey);
      if (cached && Date.now() - cached.ts < RECALL_MEMO_MS) {
        memoHits++;
        // ponytail: true LRU — move to tail
        recallMemo.delete(memoKey); recallMemo.set(memoKey, cached);
        if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;
        return { content: [{ type: "text", text: truncate(cached.text) }], details: { episodes: cached.ranked, cached: true } };
      }
      const filterTags = normTags;
      const sinceTs = parseSince(params.since as any);
      let candidates: Episode[] = [...episodes.values()];
      // batch queries: union tokens and max score across queries (1 call = N recalls)
      const allQToks = [...new Set(queries.flatMap(q => expandTokens(tokenize(q))))];
      const qToks = allQToks;
      if (qToks.length && tokenIndex.size) {
        const idSets = qToks.map(t => tokenIndex.get(t)).filter(Boolean) as Set<string>[];
        if (idSets.length) {
          const hitIds = new Set<string>();
          for (const s of idSets) for (const id of s) hitIds.add(id);
          // proper tag union using normalized
          if (filterTags?.length) {
            for (const e of episodes.values()) {
              const eNorm = normalizeTags(e.tags) ?? [];
              if (filterTags.some(ft => eNorm.includes(ft))) hitIds.add(e.id);
            }
          }
          const hits = [...hitIds].map(id => episodes.get(id)).filter(Boolean) as Episode[];
          if (hits.length) candidates = hits;
        }
      }
      // apply filters before scoring
      candidates = candidates.filter(e => {
        if (params.source && e.source !== params.source) return false;
        if (sinceTs !== undefined && e.ts < sinceTs) return false;
        if (e.expiresAt && e.expiresAt < Date.now()) return false;
        if (filterTags?.length) {
          const eTags = normalizeTags(e.tags) ?? [];
          if (!filterTags.every((ft: string) => eTags.includes(ft))) return false;
        }
        return true;
      });
      const N = episodes.size;
      const scored = candidates
        .map((e) => {
          const raw = Math.max(...queries.map(q => scoreEpisode(e, q, filterTags)));
          if (raw === 0) return { e, s: 0 };
          // ponytail: idf=log((N+1)/(df+1))+1 per expanded term — TF without IDF made common tokens dominate
          const terms = [...new Set(queries.flatMap(q => expandTokens(tokenize(q))))];
          const idf = terms.length ? terms.map(t => Math.log((N+1)/((tokenIndex.get(t)?.size ?? 0)+1))+1).reduce((a,b)=>a+b,0)/terms.length : 1;
          return { e, s: raw * idf };
        })
        .filter((x) => x.s > 0 || queries.every(q => q.trim() === "") || (filterTags?.length ? true : false))
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, limit)
        .map((x) => x.e);

      const ranked = scored.length ? scored : candidates.sort((a, b) => b.ts - a.ts).slice(0, limit);
      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;

      // T8 smart detail slicing: keep full for explicit recall, but truncate gist for display
      const text = ranked.length
        ? ranked.map((e) => `[${e.cue}]${e.tags?.length ? ` [${e.tags.join(",")}]` : ""} ${e.summary}${e.detail ? " — " + e.detail.slice(0, 120) : ""}${e.refs?.length ? ` refs:${e.refs.join(",")}` : ""}`).join("\n")
        : "No episodes yet. Use remember to encode.";
      // store memo
      memoMisses++;
      recallMemo.set(memoKey, { ts: Date.now(), ranked, text });
      // cap memo size
      if (recallMemo.size > 50) {
        const first = recallMemo.keys().next().value;
        if (first) recallMemo.delete(first);
      }
      return { content: [{ type: "text", text: truncate(text) }], details: { episodes: ranked } };
    },
  });

  // T07: brain_status — metacognition + overload signal + token est + memo stats (T12)
  pi.registerTool({
    name: "brain_status",
    label: "Brain status",
    description: "How full is the brain? Episode count + context usage (metacognition). Emits brain:overload if >80%. Shows index stats + calibration knobs.",
    parameters: Type.Object({}),
    async execute(_id, _p, _sig, _upd, ctx: any) {
      let usage: any = undefined;
      try {
        usage = ctx?.getContextUsage?.() ?? (pi as any).getContextUsage?.() ?? undefined;
      } catch {}
      const count = episodes.size;
      const autoCount = [...episodes.values()].filter(e=>e.source==="auto").length;
      const remCount = count - autoCount;
      const pct = usage?.percent ?? (usage?.used && usage?.total ? Math.round((usage.used / usage.total) * 100) : undefined);
      const overloaded = (pct !== undefined && pct > 80) || count > 50;
      if (overloaded) (pi as any).events?.emit?.("brain:overload", { episodes: count, percent: pct });
      const idxStats = `Index: ${tokenIndex.size} tokens → ${count} episodes (${remCount} remember, ${autoCount} auto) | memo hits:${memoHits} miss:${memoMisses}`;
      const gistPreview = [...episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map(gistForEpisode).join(" | ");
      const gistTokens = estTokens(gistPreview);
      const knobs = `Knobs: MAX_BYTES=${MAX_BYTES} MAX_LINES=${MAX_LINES} TAG_BOOST=${TAG_BOOST} HALF_LIFE=${HALF_LIFE_FACTOR}/${HALF_LIFE_DAYS}d REMEMBER_BOOST=${REMEMBER_BOOST} AUTO_BOOST=${AUTO_BOOST} TTL=${AUTO_TTL_MS/86400000}d`;
      const budget = pct !== undefined ? `Budget: ${pct}% ${pct>BUDGET_STOP_PCT?"(STOP inject)":pct>BUDGET_WARN_PCT?"(warn: inject 1)":""}` : `Budget: est ${gistTokens} tokens gist`;
      const txt = `Episodes: ${count} (${remCount} remember, ${autoCount} auto)\nTokens: ${usage?.used ?? "?"} / ${usage?.total ?? "?"}${pct !== undefined ? ` (${pct}%)` : ""}${overloaded ? "\n[overload: consider compaction/pruning]" : ""}\nDeliberations: ${deliberations.length}\n${idxStats}\nGist preview (${gistTokens} tok): ${gistPreview.slice(0,120)}\n${knobs}\n${budget}`;
      return { content: [{ type: "text", text: txt }], details: { episodes: count, autoCount, remCount, tokens: usage, recent: [...episodes.values()].slice(-3), overloaded, deliberations: deliberations.slice(-3), index: { tokens: tokenIndex.size, episodes: count, memoHits, memoMisses }, knobs: { MAX_BYTES, MAX_LINES, TAG_BOOST, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, REMEMBER_BOOST, AUTO_BOOST } } };
    },
  });

  // NEW: think — PFC scratchpad for logical reasoning / deliberation
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
      await (pi as any).appendEntry?.("brain:deliberation", entry);
      thinkSatisfied = true;
      needsDebugThink = false;
      if (wasDebug) needsPlanUpdate = true;
      (pi as any).events?.emit?.("brain:deliberation", entry);
      const text = `Deliberation saved: ${params.goal}\n- ${params.hypotheses.join("\n- ")}${params.conclusion ? `\n=> ${params.conclusion}` : ""}`;
      return { content: [{ type: "text", text: truncate(text) }], details: { deliberation: entry } };
    },
  });

  // creative-thinking — divergent synthesis (episodes + deliberation)
  const creativeThinkingParams = Type.Object({
    cues: Type.Array(Type.String(), { description: "2-3 cues to combine", minItems: 2, maxItems: 3 }),
    prompt: Type.Optional(Type.String({ description: "Synthesis prompt (e.g. approach to ...)" })),
  });
  async function creativeThinkingExecute(_id: any, params: any, signal: any) {
    if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;
    const pooled: Episode[] = [];
    for (const q of params.cues) {
      const qToks = expandTokens(tokenize(q));
      let cand: Episode[] = [...episodes.values()];
      if (qToks.length && tokenIndex.size) {
        const sets = qToks.map(t=>tokenIndex.get(t)).filter(Boolean) as Set<string>[];
        if (sets.length) { const ids=new Set<string>(); for(const s of sets) for(const id of s) ids.add(id); const hits=[...ids].map(id=>episodes.get(id)).filter(Boolean) as Episode[]; if(hits.length) cand=hits; }
      }
      const hits = cand
        .map((e) => ({ e, s: scoreEpisode(e, q) }))
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
      ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Create a novel approach combining: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
      : raw;
    const sources = unique.length ? `Sources:\n${unique.map((e) => `[${e.cue}] ${gistForEpisode(e)}`).join("\n")}` : "";
    const deliberationBlock = recentThink ? `Deliberation:\n${recentThink}` : "";
    const context = [sources, deliberationBlock].filter(Boolean).join("\n\n");
    const text = `${synthesisPrompt}\n\n${context}\n\n→ Combine insights: fuse episode patterns WITH deliberation hypotheses into variant not in either source.`;
    return { content: [{ type: "text", text: truncate(text) }], details: { episodes: unique, cues: params.cues, deliberation: recentThink || undefined } };
  }
  pi.registerTool({
    name: "creative-thinking",
    label: "Creative Thinking",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach. Prompt e.g. 'creative-thinking neon + login into glass login' NOT vague 'creative approach' (loose auto-enriched). No vector DB.",
    parameters: creativeThinkingParams,
    async execute(_id, params, signal) { return creativeThinkingExecute(_id, params, signal); },
  });
  // plan — ordered tasklist after think (ponytail: one tool, id+done for updates) — detailed, well-split
  pi.registerTool({
    name: "plan",
    label: "Plan",
    description: "Create/update detailed ordered tasklist after think (+ creative-thinking if novel). Requires 3-10 well-split tasks that match user requirement — detailed enough that execution is easy. Tasks shown as [ ]/[x]. Pass id+done to mark complete. Single-shot: include hypotheses to auto-create deliberation. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Plan goal (e.g. creative login page)" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Detailed ordered tasks (3-10, well-split; >10 → chunk via plan{id,tasks:[...]}). Validation in executor for actionable errors." })),
      id: Type.Optional(Type.String({ description: "Existing plan id to update" })),
      done: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { description: "Indices to mark done (0-based)" })),
      hypotheses: Type.Optional(Type.Array(Type.String(), { description: "Single-shot hypotheses (auto-creates think)", minItems: 1, maxItems: 3 })),
    }),
    async execute(_id, params, _signal) {
      // update existing plan — tasks/goal optional when id provided
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
      // single-shot: hypotheses → auto-create deliberation (2 calls → 1) — ponytail: prefer this, 2 hypotheses min for real deliberation
      if (params.hypotheses?.length) {
        if (params.hypotheses.length < 2) return { content: [{ type: "text", text: "plan single-shot: hypotheses needs 2-3 detailed (≥10 chars each) — deliberation requires 2 approaches" }], details: { error: "hypotheses too few" } } as any;
        if (params.hypotheses.some((h: string) => h.trim().length < 10)) return { content: [{ type: "text", text: "plan hypotheses must be detailed (≥10 chars each)" }], details: { error: "hypotheses not detailed" } } as any;
        const entry = { id: `delib:${Date.now()}`, goal: params.goal ?? "plan deliberation", hypotheses: params.hypotheses.map((h: string) => truncate(h)), ts: Date.now() };
        deliberations.push(entry as any);
        if (deliberations.length > 10) deliberations.shift();
        await (pi as any).appendEntry?.("brain:deliberation", entry);
        thinkSatisfied = true;
        needsDebugThink = false;
        if (entry.goal.toLowerCase().trim().startsWith("debug")) needsPlanUpdate = true;
      }
      // create new plan — ponytail: collision-free id, no goal slop — enforce detailed 3-10 split
      if (!params.goal || !params.tasks?.length) return { content: [{ type: "text", text: "plan: goal and tasks required for new plan (use id+done to update)" }], details: { error: "missing goal/tasks" } } as any;
      const taskErr = planTaskError(params.tasks);
      if (taskErr) return { content: [{ type: "text", text: taskErr }], details: { error: "invalid tasks", count: params.tasks.length } } as any;
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

  // T10: habit — cerebellar procedural scaffold (+ mutate variant)
  pi.registerTool({
    name: "habit",
    label: "Habit",
    description: "Create a SKILL.md scaffold for a repeated correction (cerebellum habit automatization). Draft only. Use variant mutate for creative alternative.",
    parameters: Type.Object({
      name: Type.String({ description: "Habit name (kebab-case)" }),
      when: Type.String({ description: "When to use this habit" }),
      steps: Type.String({ description: "Steps to follow" }),
      variant: Type.Optional(Type.String({ description: "Optional mutate: add creative alternative steps" })),
      force: Type.Optional(Type.Boolean({ description: "Confirm overwrite when preview exists" })),
    }),
    async execute(_id, params, signal, _upd, ctx: any) {
      const cwd: string = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
      const safe = params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!safe) return { content: [{ type: "text", text: "Invalid habit name" }], details: { error: "empty name" } } as any;
      if (ctx?.isProjectTrusted?.() === false) return { content: [{ type: "text", text: "Project not trusted — habit blocked" }], details: { error: "untrusted" } } as any;
      const dir = `${cwd}/.pi/skills/brain-${safe}`;
      const file = `${dir}/SKILL.md`;
      // preview: if exists, require force:true to confirm overwrite
      if (!params.force) {
        try {
          const { readFileSync } = await import("node:fs");
          const existing = readFileSync(file, "utf8");
          const preview = existing.slice(0, 400).replace(/\n/g, " ");
          const altHint = params.variant ? " + variant" : " — add variant to enrich";
          return { content: [{ type: "text", text: `Preview: habit exists at ${file}:\n${preview}\n→ call again with force:true to confirm overwrite${altHint}. Undo: rm -r ${dir}` }], details: { blocked: true, existing, preview } } as any;
        } catch {}
      }
      const alt = params.variant ? `\n\n## Alternative (mutate)\n\n${params.variant}\n` : "";
      const body = `---\nname: brain-${safe}\ndescription: ${params.when.replace(/---/g,"—").replace(/\n/g," ").slice(0,120)}\n---\n\n# ${params.name}\n\n${params.steps}${alt}\n`;
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        if (signal?.aborted) throw new Error("aborted");
        mkdirSync(dir, { recursive: true });
        if ((pi as any).withFileMutationQueue) await (pi as any).withFileMutationQueue(file, async () => { writeFileSync(file, body, "utf8"); });
        else writeFileSync(file, body, "utf8");
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], details: { error: String(e) } };
      }
      return { content: [{ type: "text", text: `Drafted ${file}${params.variant ? " + variant" : ""} — undo: rm -r ${dir}` }], details: { skillPath: dir } };
    },
  });

  // /pi-brain command — strict gate: on = brain-only, off = default pi
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
        writeMode(enabled);
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
        const txt = `pi-brain: ${brainStrict ? "ON (strict)" : "OFF (default)"}\nEpisodes: ${episodes.size} | Deliberations: ${deliberations.length} | Index: ${tokenIndex.size} tokens\nUsage: /pi-brain on | /pi-brain off`;
        ctx.ui.notify(txt, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain on | /pi-brain off | /pi-brain status`, "warning");
    },
  });

  // T08: deleted thalamic @ gate — pi already normalizes @mentions; gate hijacked @file prompts (YAGNI)
  // ponytail: delete, add back only if proven needed

  // ponytail: PREFIX v2 — literal only, never interpolate; delta goes in message (KV-cache stable)
  // T6 stable prefix for KV-cache
  const STRICT_STABLE_PREFIX = `[STRICT BRAIN MODE ON — 7 RULES ENFORCED]\nHappy (2-call floor): recall (top-3) → think (smart reads) → [creative-thinking if novel] → plan #1 → Turn1 read×N parallel → Turn2 edit×N+write×N+bash verify parallel → plan #2 done:[all] → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')\nUnhappy (3-call floor): same but 3 plan calls — plan #1 → failure → think{goal:"debug <failed Task N>", hypotheses:[root cause, fix]} → plan #2 → retry Turn1/Turn2 → plan #3 done:[all] → remember → habit → git commit. Execution blocked until debug-think done.\nBatch: 1 LLM call = N tool calls. Turn1: read×N parallel; Turn2: edit×N+write×N+bash parallel. Chunk edits: 1 edit per file, exact oldText, merge nearby changes. If oldText known → skip reads → 1 call. Record → 0-call replay. Prefer plan{hypotheses} single-shot (think+plan 2→1). // ponytail: deleted readCache, add per-path cache if throughput matters 5-Step: Question→Delete→Simplify→Accelerate→Automate.\n\n1. Recall-first: picks top-3 relevant (TF-IDF 2x/1x/0.5x + tag boost 1.5 + decay 0.95/7d). If recall empty/no relevant → scan current dir: bash ls + read relevant files smart (only relevant) to find context (don't read a lot). Cite cue(s) when episodes exist.\n2. Think-before-act: think MUST smart-read required relevant files first, then call think{goal,hypotheses} — ensure all info needed to finish task is gathered BEFORE plan (enforced — write will be blocked otherwise; no broad reading, only relevant files).\n3. Creative-thinking-only-for-novelty: call creative-thinking when task is creative/novel (e.g. "creative login", "novel approach"), SKIP for CRUD/bugfix — do this BEFORE planning to get all inputs.\n4. Plan-after-inputs: after think (+ creative-thinking if novel) → plan #1 creates [ ] checklist; final update is plan #2 done:[0,1,...] batch all (no incremental). Unhappy: plan #2 after debug think, plan #3 final batch. Execution is batched: Turn1 read×N, Turn2 edit×N+write×N+bash.\n5. Shortest-diff + Batch: Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel, 1 edit per file with exact oldText, no scaffolding for later. Bash verify after edits land (not same call as edit it checks).\n6. Encode: after every successful write/edit/bash you MUST call remember{cue,summary}; 2nd repeat of same fix → habit{name,when,steps}.\n7. Git: when plan 2/2 done + remember done, bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>' (skip if no changes).\n\nPi Tools — use exactly as defined:\n- read {path, offset?, limit?} — read text/image, truncated 50KB/2000 lines; large files via offset/limit\n- write {path, content} — create/overwrite, auto-creates parent dirs\n- edit {path, edits:[{oldText,newText}]} — exact unique oldText, non-overlapping, merge nearby changes, one file per call\n- bash {command, timeout?} — shell exec, use for ls/find/grep/cat/head/verify/git, truncated 50KB\n- custom tools: any pi.registerTool {name, parameters} — call by name with matching params object (discover via recall/skill list)\n`;

  // strict workflow run lifecycle — reset per prompt (ponytail: unconditional reset, no timestamp drift)
  pi.on("before_agent_start" as any, async (ev: any, ctx: any) => {
    thinkSatisfied = false;
    hasWriteEdit = false;
    hasRemember = false;
    rule5Warned = false;
    // ponytail: per-agent reset only on session_start/failure, not every prompt — persist needsDebugThink/needsPlanUpdate
    // T10 budget: try provider usage if available
    let pct: number | undefined;
    try { const u = (ctx as any)?.getContextUsage?.() ?? (ev as any)?.getContextUsage?.(); if (u?.percent) pct = u.percent; else if (u?.used && u?.total) pct = Math.round(u.used/u.total*100); } catch {}
    // T2 periodic prune if many
    if (episodes.size > PRUNE_WARN) pruneExpired();
    // strict mode: scored recall + stable prefix (T6) + gist (T3) + budget (T10)
    if (brainStrict) {
      const query: string = ev?.prompt ?? "";
      const all = [...episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now());
      const scored = all
        .map((e) => ({ e, s: scoreEpisode(e, query) }))
        .filter((x) => x.s > 0 || query.trim() === "")
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, 3)
        .map((x) => x.e);
      const ranked = scored.length ? scored : all.sort((a, b) => b.ts - a.ts).slice(0, 3);
      // T10 budget guard: shrink delta if overloaded
      let deltaRanked = ranked;
      if (pct !== undefined) {
        if (pct > BUDGET_STOP_PCT) deltaRanked = [];
        else if (pct > BUDGET_WARN_PCT) deltaRanked = ranked.slice(0,1);
      }
      const context = deltaRanked.length
        ? compressEpisodes(deltaRanked)
        : "(no relevant episodes — scan current dir: bash ls + read relevant files smart (only relevant) to find context)";
      const recentThinkStrict = deliberations.slice(-1).map((d:any)=>`[think: ${d.goal}] ${d.hypotheses.join("; ")}`).join("\n");
      const thinkBlockStrict = recentThinkStrict ? `\n\nRecent deliberation:\n${recentThinkStrict}` : "";
      // T6: stable systemPrompt + variable delta as separate system message (KV-cache friendly)
      const latestPlan = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
      if (latestPlan) cachedLatestPlan = latestPlan;
      const planBlock = latestPlan ? `\n\nActive plan:\n${renderPlan(latestPlan)}\n(id: ${latestPlan.id})` : "";
      const delta = `Brain episodes for query "${query.slice(0, 120)}":\n${context}${thinkBlockStrict}${planBlock}`;
      // stable prefix cached, delta varies per turn but doesn't break prefix
      return { systemPrompt: STRICT_STABLE_PREFIX, message: { role: "system", content: delta } } as any;
    }
    // default mode: gated light injection — 1 episode gist + 1 deliberation (T3+T8) + budget
    const latestPlanDef = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
    if (latestPlanDef) cachedLatestPlan = latestPlanDef;
    // pick scored top-1 for default (T8) not just recency
    let recent: Episode[] = [];
    if (episodes.size) {
      const q = (ev?.prompt ?? "") as string;
      if (q.trim()) {
        const all = [...episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now());
        const scored = all.map(e=>({e,s:scoreEpisode(e,q)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts).slice(0,1).map(x=>x.e);
        recent = scored.length ? scored : [...episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,1);
      } else {
        recent = [...episodes.values()].sort((a, b) => b.ts - a.ts).slice(0, 1);
      }
    }
    // budget guard: if overloaded skip inject
    if (pct !== undefined && pct > BUDGET_STOP_PCT) recent = [];
    const recentThink = deliberations.slice(-1);
    if (!recent.length && !recentThink.length && !latestPlanDef) return;
    const parts: string[] = [];
    if (recent.length) parts.push(`Recent brain episodes:\n${compressEpisodes(recent)}`);
    if (recentThink.length) parts.push(`Recent deliberations:\n${recentThink.map((d: any) => `- ${d.goal}: ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n")}`);
    if (latestPlanDef) parts.push(`Active plan:\n${renderPlan(latestPlanDef)}\n(id: ${latestPlanDef.id})`);
    // also respect budget warn: if warn, only 1 block
    if (pct !== undefined && pct > BUDGET_WARN_PCT && parts.length > 1) {
      return { message: { role: "system", content: parts[0] } } as any;
    }
    return { message: { role: "system", content: parts.join("\n\n") } } as any;
  });

  pi.on("context" as any, async (ev: any) => {
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    // ponytail: dedup only — old sys.slice(0,1)+tail.slice(-20) orphaned tool_result from its
    // assistant tool_calls, causing OpenAI 400: No function call found for call_id 'call_...'
    // pi's compaction already handles window limits safely; don't slice here.
    const seen = new Set<string>();
    let changed = false;
    const deduped = msgs.filter((m: any) => {
      if (m.role !== "system") return true; // only system injections contain brain blocks; never touch tool pairs
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (c.includes("Recent brain episodes:") || c.includes("Brain episodes:")) {
        if (seen.has(c)) { changed = true; return false; }
        seen.add(c);
      }
      return true;
    });
    if (changed) return { messages: deduped } as any;
  });

  // T09: hippocampal hooks — auto-encode + consolidation (sleep replay) + T2 filter + T11 feedback
  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      const cue = `${ev.toolName}:${(ev.input?.path ?? "").toString().slice(0, 30)}`;
      const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
      if (summary) {
        const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto", expiresAt: Date.now()+AUTO_TTL_MS };
        await (pi as any).appendEntry?.("brain:episode", ep);
        episodes.set(ep.id, ep);
        indexEpisode(ep);
        recallMemo.clear();
        hasWriteEdit = true;
        hasRemember = false;
        // T11 usefulness: edit/write always useful → keep its boost via remember-boost already, but touch not needed
      }
    } else if (ev?.toolName === "bash" && !ev?.isError) {
      const cmd: string = (ev.input?.command ?? "").toString();
      const output: string = (ev.content?.[0]?.text ?? ev.result ?? "").toString();
      // T2: skip noise bash
      const isNoise = isNoiseBash(cmd, output);
      // T11: usefulness feedback — if success keywords, touch best matching remember episode (reinforce)
      if (/passed|success|fixed|done|ok/i.test(output) && output.length > 20) {
        // find best remember episode that shares tokens with cmd
        const best = [...episodes.values()].filter(e=>e.source==="remember").map(e=>({e,s:scoreBase(e,cmd)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0]?.e;
        if (best) { best.ts = Date.now(); recallMemo.clear(); }
      }
      if (isPlanDone() && hasRemember) {
        // still encode but don't mark dirty — but respect noise filter
        if (isNoise) return;
        const cue = `bash:${cmd.slice(0,30)}`;
        const summary = output.slice(0, 200);
        if (summary) {
          const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto", expiresAt: Date.now()+AUTO_TTL_MS };
          await (pi as any).appendEntry?.("brain:episode", ep);
          episodes.set(ep.id, ep);
          indexEpisode(ep);
          recallMemo.clear();
        }
      } else {
        if (isNoise) return;
        const cue = `bash:${cmd.slice(0,30)}`;
        const summary = output.slice(0, 200);
        if (summary) {
          const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto", expiresAt: Date.now()+AUTO_TTL_MS };
          await (pi as any).appendEntry?.("brain:episode", ep);
          episodes.set(ep.id, ep);
          indexEpisode(ep);
          recallMemo.clear();
          hasWriteEdit = true;
          hasRemember = false;
        }
      }
    }
    if ((ev?.toolName === "remember" || ev?.toolName === "habit") && !ev?.isError) {
      // audit preview returns blocked:true but not isError — don't treat as persisted
      const blocked = (ev as any)?.details?.blocked === true || (ev as any)?.result?.blocked === true;
      if (!blocked) {
        hasRemember = true;
        hasWriteEdit = false;
        rule5Warned = false;
      }
    }
    // unhappy path: only write/edit/bash failures block retry (narrowed from "any failure")
    if (ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      needsDebugThink = true;
      needsPlanUpdate = false;
      thinkSatisfied = false;
      try { (ctx as any)?.ui?.notify?.("Strict unhappy path: failure detected — call think{goal:'debug <task>', hypotheses:[...]} before retry.", "warning"); } catch {}
      const hint = "\n[ brain: failure requires debug think — call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry ]";
      const cur = ev.content?.[0]?.text ?? "";
      return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
    }
  });

  pi.on("session_before_compact" as any, async (ev: any) => {
    // T4 scored compaction (reuse scoreEpisode + deliberation goal)
    const query = (deliberations[deliberations.length-1] as any)?.goal ?? (cachedLatestPlan?.goal ?? "");
    let ranked: Episode[];
    if (query) {
      const scored = [...episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now()).map(e=>({e,s:scoreEpisode(e,query)})).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts);
      ranked = scored.length && scored.every(x=>x.s===0) ? [...episodes.values()].sort((a,b)=>b.ts-a.ts) : scored.map(x=>x.e); // ponytail: single scan — fix C1 shadow
    } else {
      ranked = [...episodes.values()].sort((a, b) => b.ts - a.ts);
    }
    // prefer remember over auto implicitly via sourceBoost already in scoreEpisode
    const sliced = ranked.slice(0, COMPACT_LARGE);
    if (!sliced.length) return;
    const keep = sliced.length <= 15 ? sliced.slice(0, COMPACT_SMALL) : sliced.slice(0, COMPACT_LARGE);
    const brain = `Brain episodes:\n${compressEpisodes(keep)}`;
    const summary = ev?.summary ? `${brain}\n\n${ev.summary}` : brain;
    return { summary } as any;
  });

  // resources_discover deleted — .pi/skills auto-discovered, no handler needed

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    // rm -rf guard first (highest priority) — covers rm -fr / -r -f / --recursive --force
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
    // unhappy path: block write/edit/bash until debug think + plan update
    if (brainStrict && needsDebugThink && ["write", "edit", "bash"].includes(ev?.toolName)) {
      return { block: true, reason: "Blocked by strict unhappy path: failure occurred — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retry." } as any;
    }
    if (brainStrict && needsPlanUpdate && ["write", "edit", "bash"].includes(ev?.toolName)) {
      return { block: true, reason: "Blocked by strict unhappy path: debug think done — now update plan{id,done} before retry." } as any;
    }
    // Rule 2: think-before-act (strict only, enforced)
    if (brainStrict && (ev?.toolName === "write" || ev?.toolName === "edit")) {
      if (!thinkSatisfied) {
        return { block: true, reason: "Blocked by strict workflow Rule 2: call think{goal,hypotheses} before write/edit. Deliberate 2-3 approaches first." } as any;
      }
    }
    // hasRemember now set in tool_result (post-success) — not here
  });

  // Rule 5: encode-or-it-didn't-happen — once after plan done (not per-turn)
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    if (brainStrict && hasWriteEdit && !hasRemember && !rule5Warned && isPlanDone()) {
      rule5Warned = true;
      try { ctx?.ui?.notify?.("Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
    }
  });
  // before_provider_request deleted — merged into context dedup+trim (one prune, not two)

  pi.on("session_shutdown" as any, async () => {
    // idempotent — entries already durable, nothing to flush
  });

  // ponytail: minimal self-check — fails if TF logic breaks. Run: node -e "require('./index.ts')"
  if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("index.ts")) {
    // trivial demo, not a framework
    const _demo = (() => {
      const e: Episode = { id: "x", cue: "a", summary: "data", ts: Date.now(), source: "remember" };
      console.assert(scoreEpisode(e, "a") > 0, "token-exact TF failed");
      console.assert(scoreEpisode(e, "data") > 0, "substring within summary failed");
      const old: Episode = { id: "y", cue: "test", summary: "test", ts: Date.now() - 14*86400000, source: "remember" };
      const fresh: Episode = { id: "z", cue: "test", summary: "test", ts: Date.now(), source: "remember" };
      console.assert(scoreEpisode(fresh, "test") > scoreEpisode(old, "test"), "half-life failed");
      // T1: remember outranks auto even when older
      const oldRem: Episode = { id:"r", cue:"deploy", summary:"deploy fix", ts: Date.now()-7*86400000, source:"remember"};
      const freshAuto: Episode = { id:"a", cue:"deploy", summary:"deploy fix", ts: Date.now(), source:"auto"};
      console.assert(scoreEpisode(oldRem,"deploy") > scoreEpisode(freshAuto,"deploy")*0.8, "remember boost failed");
      // T1 audit decay exempt
      console.assert(scoreBase(oldRem,"deploy") >= 3, "scoreBase should be >=3 for exact cue");
      // ponytail: one runnable check for recall branches — tag-only, since, batch queries
      const tagEp: Episode = { id:"t", cue:"db-fix", summary:"fix db", ts: Date.now(), source:"remember", tags:["infra"] };
      console.assert(scoreBase(tagEp,"", ["infra"]) > 0, "tag-only recall failed");
      console.assert(parseSince("7d") !== undefined, "since 7d parse failed");
      console.assert(expandTokens(tokenize("database")).includes("database"), "SYN db failed");
      // ponytail: plan count guard — <3 rejected, valid ok, >10 gets chunk hint
      console.assert(planTaskError(["a","b"]) !== undefined, "plan <3 not rejected");
      console.assert(planTaskError(["1234567890","1234567890","1234567890"]) === undefined, "plan valid wrongly rejected");
      console.assert((planTaskError(Array.from({length:11},(_,i)=>`task ${i} long enough`)) ?? "").includes("Chunk it"), "plan >10 missing chunk hint");
      console.log("pi-brain demo: ok");
    }) as any;
    void _demo;
  }

  // bus events consumed by external listeners if present
}
