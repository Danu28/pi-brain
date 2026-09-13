import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_BOOST, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, REMEMBER_BOOST, TAG_BOOST } from "./knobs";
import type { BrainEpisode } from "./types";

export function tokenize(s: string): string[] {
  try { return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); } catch { return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
}

export function normalizeTags(tags?: string[]): string[] | undefined {
  if (!tags?.length) return undefined;
  const out = tags.map(t => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, "-").replace(/-+/g,"-").replace(/^-|-$/g,"")).filter(Boolean).slice(0,8);
  return out.length ? [...new Set(out)] : undefined;
}

export function parseSince(since?: string | number): number | undefined {
  if (since == null) return undefined;
  if (typeof since === "number") return since;
  const s = String(since).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+)(h|d)$/);
  if (m) return Date.now() - Number(m[1]) * (m[2]==="h"?3600000:86400000);
  const parsed = Date.parse(s);
  return isNaN(parsed) ? undefined : parsed;
}

// Synonym map (tiny, local, no embedding) + user override merge
const SYN: Record<string, string[]> = {
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
// SYN override — pi-brain.syn.json merges if present (add when miss >20%)
try { const _syn = JSON.parse(readFileSync(join(process.cwd(),"pi-brain.syn.json"),"utf8")); Object.assign(SYN, _syn); } catch {}
try { const _syn2 = JSON.parse(readFileSync(join(homedir(),".pi","agent","pi-brain.syn.json"),"utf8") as any); Object.assign(SYN, _syn2); } catch {}

export function expandTokens(toks: string[]): string[] {
  const out = new Set<string>();
  for (const t of toks) {
    out.add(t);
    if (SYN[t]) for (const s of SYN[t]) out.add(s);
  }
  return [...out];
}

// T10 token estimator
export function estTokens(s: string): number { return Math.ceil(s.length / 3.5); }

// T3 gist helpers
export function gistForEpisode(e: BrainEpisode): string {
  const first = e.summary.split(/[.!?\n]/)[0]?.trim() || e.summary;
  const base = `${e.cue}: ${first}`;
  const tagPart = e.tags?.length ? ` [${e.tags.join(",")}]` : "";
  const raw = base + tagPart;
  return raw.length > 120 ? raw.slice(0,117) + "..." : raw;
}

export function compressEpisodes(list: BrainEpisode[]): string {
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
export function scoreBase(e: BrainEpisode, query: string, filterTags?: string[]): number {
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

function sourceBoost(e: BrainEpisode): number {
  return e.source === "remember" ? REMEMBER_BOOST : e.source === "auto" ? AUTO_BOOST : 1;
}

export function scoreEpisode(e: BrainEpisode, query: string, filterTags?: string[]): number {
  const base = scoreBase(e, query, filterTags);
  if (base === 0) return 0;
  const ageDays = Math.max(0, (Date.now() - e.ts) / 86400000); // M1: clamp future timestamps
  const decay = Math.pow(HALF_LIFE_FACTOR, ageDays / HALF_LIFE_DAYS);
  return base * decay * sourceBoost(e);
}

// eslint-disable-next-line @typescript-eslint/no-shadow
export function planTaskError(tasks: string[]): string | undefined {
  if (tasks.length < 3) return `plan requires ≥3 detailed tasks (got ${tasks.length}) — split into 3-10 well-structured steps. Example: ["analyze requirement & existing code","update index.ts core logic","update docs & verify"]`;
  if (tasks.length > 10) return `plan got ${tasks.length} tasks — max 10. Chunk it: create with the first 10, then append plan{id:"<id>", tasks:["remaining…"]}. Or merge related steps.`;
  const short = tasks.filter((t) => t.trim().length < 10);
  if (short.length) return `plan tasks must be detailed (≥10 chars each) — short: "${short[0].slice(0,30)}" — make each concrete and actionable (what file, what change)`;
  return undefined;
}