import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_BOOST, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, MAX_BYTES, MAX_LINES, PRUNE_CAP, REMEMBER_BOOST, TAG_BOOST } from "./knobs";
import { brain, isVerbose } from "./state";
import type { BrainEpisode } from "./types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
const SYN: Record<string, string[]> = {
  deploy: ["deploy","ship","release","publish"], bug: ["bug","fix","error","issue","fail"],
  auth: ["auth","login","signin","credential"], perf: ["perf","performance","speed","slow","latency"],
  cache: ["cache","memo","store"], test: ["test","spec","pytest","jest","vitest"],
  build: ["build","compile","bundle"], cold: ["cold","start","init","boot"],
  db: ["db","database","store","storage"], ui: ["ui","frontend","interface","view"],
};
function loadSyn(p:string){ try{ Object.assign(SYN, JSON.parse(readFileSync(p,"utf8"))); }catch{} }
loadSyn(join(process.cwd(),"pi-brain.syn.json"));
loadSyn(join(homedir(),".pi","agent","pi-brain.syn.json"));
export function truncate(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n") + `\n[truncated ${lines.length - MAX_LINES} lines]`;
  const byteLen = typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : new TextEncoder().encode(text).length;
  if (byteLen > MAX_BYTES) {
    if (typeof Buffer !== "undefined") text = Buffer.from(text, "utf8").slice(0, MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + "\n[truncated to 50KB]";
    else text = text.slice(0, MAX_BYTES) + "\n[truncated to 50KB]";
  }
  return text;
}

export function expandTokens(toks: string[]): string[] {
  const out = new Set<string>();
  for (const t of toks) { out.add(t); if (SYN[t]) for (const s of SYN[t]) out.add(s); }
  return [...out];
}
export function estTokens(s: string): number { return Math.ceil(s.length / 3.5); }
export function gistForEpisode(e: BrainEpisode): string {
  const first = e.summary.split(/[.!?\n]/)[0]?.trim() || e.summary;
  const base = `${e.cue}: ${first}`;
  const tagPart = e.tags?.length ? ` [${e.tags.join(",")}]` : "";
  const raw = base + tagPart;
  return raw.length > 120 ? raw.slice(0,117) + "..." : raw;
}

// QDS — Question→Delete→Simplify: human-like forgetting
// Question: is it worth keeping? Delete: drop trivia. Simplify: keep gist.
// Relevance 0-10 at encode time — like human deciding "does this matter?"
export function relevanceForRemember(cue: string, summary: string, detail: string | undefined, tags: string[] | undefined, refs: string[] | undefined): { score: number; label: string; reasons: string[] } {
  let s = 0; const reasons: string[] = [];
  const cueLen = cue.trim().length;
  if (cueLen >= 8 && cueLen <= 30) { s += 2; reasons.push("cue specific 8-30"); }
  else if (cueLen >= 3 && cueLen < 8) { s += 1; reasons.push("cue short"); }
  else if (cueLen > 30) { s += 1; reasons.push("cue long"); }
  if (cue.includes("-")) { s += 1; reasons.push("cue kebab"); }
  const generic = new Set(["fix", "bug", "test", "note", "todo", "tmp"]);
  if (generic.has(cue.trim().toLowerCase())) { s -= 2; reasons.push("cue generic"); }
  const sumLen = summary.trim().length;
  if (sumLen < 20) { reasons.push("summary too short (<20)"); }
  else if (sumLen < 50) { s += 2; reasons.push("summary 20-50"); }
  else if (sumLen < 120) { s += 3; reasons.push("summary 50-120"); }
  else if (sumLen < 200) { s += 2; reasons.push("summary 120-200"); }
  else { s += 1; reasons.push("summary >200 truncated"); }
  if (detail && detail.trim().length >= 10) { s += 1; reasons.push("detail +1"); }
  if (tags?.length) { const add = Math.min(tags.length * 0.8, 2.4); s += add; reasons.push(`tags +${add.toFixed(1)}`); }
  if (refs?.length) { const add = Math.min(refs.length * 0.5, 1.5); s += add; reasons.push(`refs +${add.toFixed(1)}`); }
  s = Math.max(0, Math.min(10, Math.round(s * 10) / 10));
  const label = s >= 7 ? "high" : s >= 4 ? "medium" : "low";
  return { score: s, label, reasons };
}
export function relevanceLabel(score: number): string { return score >= 7 ? "high" : score >= 4 ? "medium" : "low"; }
export function formatRelevance(score: number): string {
  const pct = Math.round((score / 10) * 100);
  const bar = "█".repeat(Math.round(score / 2)) + "░".repeat(5 - Math.round(score / 2));
  return `${score.toFixed(1)}/10 ${pct}% ${bar} ${relevanceLabel(score)}`;
}
export function compressEpisodes(list: BrainEpisode[]): string {
  const seen = new Set<string>(); const out: string[] = [];
  for (const e of list) { const k = e.cue.toLowerCase().trim(); if (seen.has(k)) continue; seen.add(k); out.push(`- ${gistForEpisode(e)}`); if (out.length >= 3) break; }
  return out.join("\n");
}
export function scoreBase(e: BrainEpisode, query: string, filterTags?: string[]): number {
  const terms = tokenize(query); const expanded = expandTokens(terms);
  const hasQuery = terms.length > 0 || query.trim().length > 0;
  const qLower = query.toLowerCase().trim(); let s = 0;
  const cueToks = tokenize(e.cue), sumToks = tokenize(e.summary), detToks = tokenize(e.detail ?? "");
  if (qLower && e.cue.toLowerCase().includes(qLower)) s += 2;
  if (qLower && e.summary.toLowerCase().includes(qLower)) s += 1;
  for (const t of expanded) { s += cueToks.filter(x=>x===t).length*2; s += sumToks.filter(x=>x===t).length*1; s += detToks.filter(x=>x===t).length*0.5; }
  const normFilterTags = normalizeTags(filterTags as any);
  if (e.tags?.length) {
    const eTagsNorm = normalizeTags(e.tags) ?? [];
    for (const t of expanded) if (eTagsNorm.includes(t)) s += TAG_BOOST;
    if (normFilterTags?.length) for (const ft of normFilterTags) if (eTagsNorm.includes(ft)) s += TAG_BOOST;
  }
  if (!hasQuery && normFilterTags?.length && e.tags?.length) {
    const eTagsNorm = normalizeTags(e.tags) ?? [];
    const matchedCount = normFilterTags.filter(ft=>eTagsNorm.includes(ft)).length;
    if (matchedCount && s === 0) s = matchedCount * TAG_BOOST;
  }
  return s;
}
function sourceBoost(e: BrainEpisode): number { return e.source==="remember"?REMEMBER_BOOST:e.source==="auto"?AUTO_BOOST:1; }
export function scoreEpisode(e: BrainEpisode, query: string, filterTags?: string[]): number {
  const base = scoreBase(e, query, filterTags); if (base===0) return 0;
  const ageDays = Math.max(0,(Date.now()-e.ts)/86400000);
  return base * Math.pow(HALF_LIFE_FACTOR, ageDays/HALF_LIFE_DAYS) * sourceBoost(e);
}
export function avgIdf(terms: string[]): number {
  const N = brain.episodes.size; if (!terms.length) return 1;
  return terms.reduce((a,t)=>a+Math.log((N+1)/((brain.tokenIndex.get(t)?.size??0)+1))+1,0)/terms.length;
}
// eslint-disable-next-line @typescript-eslint/no-shadow
export function planTaskError(tasks: string[]): string | undefined {
  if (tasks.length < 3) return `plan requires ≥3 detailed tasks (got ${tasks.length}) — split into 3-10 well-structured steps. Example: ["analyze requirement & existing code","update index.ts core logic","update docs & verify"]`;
  if (tasks.length > 10) return `plan got ${tasks.length} tasks — max 10. Chunk it: create with the first 10, then append plan{id:"<id>", tasks:["remaining…"]}. Or merge related steps.`;
  const short = tasks.filter(t=>t.trim().length<10);
  if (short.length) return `plan tasks must be detailed (≥10 chars each) — short: "${short[0].slice(0,30)}" — make each concrete and actionable (what file, what change)`;
  return undefined;
}
function toksFor(e: BrainEpisode): Set<string> { return new Set([...tokenize(e.cue), ...tokenize(e.summary), ...tokenize(e.detail??""), ...(e.tags??[]).map(t=>t.toLowerCase())]); }
export function indexEpisode(e: BrainEpisode) { for (const tok of toksFor(e)) { let set=brain.tokenIndex.get(tok); if(!set){ set=new Set(); brain.tokenIndex.set(tok,set); } set.add(e.id); } }
export function unindexEpisode(e: BrainEpisode) { for (const tok of toksFor(e)) { const set=brain.tokenIndex.get(tok); if(set){ set.delete(e.id); if(set.size===0) brain.tokenIndex.delete(tok); } } }
export function rebuildIndex(){ brain.tokenIndex.clear(); for(const e of brain.episodes.values()) indexEpisode(e); }
export function pruneExpired(pi: ExtensionAPI): number {
  const now=Date.now(); let n=0;
  const evicted: string[] = [];
  for(const [id,e] of brain.episodes) if(e.expiresAt&&e.expiresAt<now){ unindexEpisode(e); brain.episodes.delete(id); n++; evicted.push(id); }
  if(n) brain.recallMemo.clear();
  while(brain.episodes.size>PRUNE_CAP){
    const sorted=[...brain.episodes.values()].sort((a,b)=>a.ts-b.ts);
    const oldest=sorted.find(e=>e.source==="auto")??sorted[0]; if(!oldest) break;
    if(oldest.source!=="auto") (pi as any).events?.emit?.("brain:overload",{evictRemember:oldest.cue,size:brain.episodes.size});
    unindexEpisode(oldest); brain.episodes.delete(oldest.id); n++; evicted.push(oldest.id); brain.recallMemo.clear();
  }
  if (n) { brain.stats.prune += n; (pi as any).events?.emit?.("brain:prune", { n, remaining: brain.episodes.size, evicted: evicted.slice(0,5) }); if (isVerbose()) try { (pi as any).events?.emit?.("brain:verbose", `prune ${n} → ${brain.episodes.size} left`); } catch {} }
  return n;
}
export function candidatePool(query: string): BrainEpisode[] {
  const qToks=expandTokens(tokenize(query));
  if(qToks.length&&brain.tokenIndex.size){
    const idSets=qToks.map(t=>brain.tokenIndex.get(t)).filter(Boolean) as Set<string>[];
    if(idSets.length){
      const ids=new Set<string>(); for(const s of idSets) for(const id of s) ids.add(id);
      const hits=[...ids].map(id=>brain.episodes.get(id)).filter(Boolean) as BrainEpisode[];
      if(hits.length) return hits;
    }
  }
  return [...brain.episodes.values()];
}
