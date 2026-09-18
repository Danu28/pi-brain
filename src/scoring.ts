import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { AUTO_BOOST, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, PRUNE_CAP, REMEMBER_BOOST, TAG_BOOST, truncate } from "./knobs";
import { brain, isVerbose } from "./state";
import type { BrainEpisode } from "./types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { truncate };

export function tokenize(s: string): string[] {
  try { return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); } catch { return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
}
const tokenizeCache = new Map<string, string[]>();
export function tokenizeCached(s: string): string[] {
  let hit = tokenizeCache.get(s);
  if (hit) return hit;
  hit = tokenize(s);
  if (tokenizeCache.size > 64) tokenizeCache.clear();
  tokenizeCache.set(s, hit);
  return hit;
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
const SYN: Record<string, string[]> = {};
function loadSyn(p:string){ try{ const j=JSON.parse(readFileSync(p,"utf8")); if(j && typeof j==="object") Object.assign(SYN, j); }catch{} }
// file-only SYN — defaults shipped as pi-brain.syn.json in repo; user overrides via cwd / agent dir
loadSyn(join(process.cwd(),"pi-brain.syn.json"));
loadSyn(join(homedir(),".pi","agent","pi-brain.syn.json"));
// also try package-local fallback (when cwd is test sandbox)
try { loadSyn(join(__dirname, "../pi-brain.syn.json")); } catch {}

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

// Single-pass rubric parser — one regex covers cost/risk/rev any order, any pipe layout
const RUBRIC_RE = /(cost|risk|rev(?:ersibility)?)\s*:\s*(\d{1,2})/gi;
export function parseDebater(hyp: string): { side: string; argues: string; cost?: number; risk?: number; reversibility?: number } {
  const parts = hyp.split("|").map(s=>s.trim()).filter(Boolean);
  let side: string;
  let argues: string;
  if (parts.length === 0) return { side: hyp.slice(0,40), argues: hyp };
  if (parts.length === 1) {
    // no pipe — plain argues
    const m = [...hyp.matchAll(RUBRIC_RE)];
    let cost: number|undefined, risk: number|undefined, reversibility: number|undefined;
    for (const [,k,v] of m) {
      const n = Math.max(0, Math.min(10, Number(v)));
      if (k.toLowerCase()==="cost") cost=n; else if(k.toLowerCase()==="risk") risk=n; else reversibility=n;
    }
    return { side: hyp.slice(0,40), argues: hyp, cost, risk, reversibility };
  }
  side = parts[0] || hyp.slice(0,30);
  // find which parts are rubric vs argues: rubrics contain cost/risk/rev
  const rubricParts: string[] = [];
  let arguesParts: string[] = [];
  for (let i=1;i<parts.length;i++) {
    if (/cost\s*:|risk\s*:|rev(?:ersibility)?\s*:/i.test(parts[i])) rubricParts.push(parts[i]);
    else arguesParts.push(parts[i]);
  }
  if (!arguesParts.length) arguesParts = [parts[parts.length-1]];
  argues = arguesParts.join(" | ");
  const scan = rubricParts.join(" ") + " " + hyp;
  let cost: number|undefined, risk: number|undefined, reversibility: number|undefined;
  for (const [,k,v] of scan.toLowerCase().matchAll(RUBRIC_RE) as any) {
    const n = Math.max(0, Math.min(10, Number(v)));
    const lk = k.toLowerCase();
    if (lk==="cost") cost=n; else if(lk==="risk") risk=n; else reversibility=n;
  }
  // dedupe: re-scan whole hyp to catch rubric before first pipe too
  const full: any = [...hyp.toLowerCase().matchAll(RUBRIC_RE)];
  for (const [,k,v] of full) {
    const n = Math.max(0, Math.min(10, Number(v)));
    const lk = k.toLowerCase();
    if (lk==="cost" && cost===undefined) cost=n; else if(lk==="risk" && risk===undefined) risk=n; else if(lk.startsWith("rev") && reversibility===undefined) reversibility=n;
  }
  return { side, argues, cost, risk, reversibility };
}
export function rubricForHypothesis(hyp: string, relevance: number): { cost: number; risk: number; reversibility: number; relevance: number; avg: number } {
  const p = parseDebater(hyp);
  const cost = p.cost ?? 5;
  const risk = p.risk ?? 5;
  const reversibility = p.reversibility ?? 8;
  const avg = Math.round(((relevance + (10 - cost) + (10 - risk) + reversibility) / 4) * 10) / 10;
  return { cost, risk, reversibility, relevance, avg };
}
export function compressEpisodes(list: BrainEpisode[]): string {
  const seen = new Set<string>(); const out: string[] = [];
  for (const e of list) { const k = e.cue.toLowerCase().trim(); if (seen.has(k)) continue; seen.add(k); out.push(`- ${gistForEpisode(e)}`); if (out.length >= 3) break; }
  return out.join("\n");
}

export function parsePlanTask(raw: string): { title: string; refs?: string[]; check?: string; estimate?: string; risk?: number; depends?: number[] } {
  const parts = raw.split("|").map(s=>s.trim());
  const title = parts[0] || raw;
  let refs: string[] | undefined, check: string | undefined, estimate: string | undefined, risk: number | undefined, depends: number[] | undefined;
  const refsM = raw.match(/refs?\s*:\s*([^|]+)/i); if (refsM) refs = refsM[1].split(/[,\s]+/).map(s=>s.trim()).filter(Boolean).slice(0,5);
  const checkM = raw.match(/check\s*:\s*([^|]+)/i); if (checkM) check = checkM[1].trim();
  const estM = raw.match(/estimate\s*:\s*([^|]+)/i); if (estM) estimate = estM[1].trim(); else {
    const m = raw.match(/(\d+\s*m(?:in)?)/i); if (m) estimate = m[1];
  }
  const riskM = raw.match(/risk\s*:\s*(\d{1,2})/i); if (riskM) risk = Math.max(0, Math.min(10, Number(riskM[1])));
  const depM = raw.match(/depends?\s*:\s*([^|]+)/i); if (depM) depends = depM[1].split(/[,\s]+/).map(s=>s.trim()).filter(Boolean).map(n=>Number(n)).filter(n=>!isNaN(n));
  if (!refs) {
    const fileM = title.match(/(src\/[^\s,]+\.ts|\.pi\/[^\s]+)/g);
    if (fileM) refs = fileM.slice(0,3);
  }
  return { title: title.split(/\s+refs?:/i)[0].split(/\s+check:/i)[0].trim(), refs, check, estimate, risk, depends };
}
export function scoreBase(e: BrainEpisode, query: string, filterTags?: string[]): number {
  const terms = tokenizeCached(query); const expanded = expandTokens(terms);
  const hasQuery = terms.length > 0 || query.trim().length > 0;
  const qLower = query.toLowerCase().trim(); let s = 0;
  const cueToks = tokenizeCached(e.cue), sumToks = tokenizeCached(e.summary), detToks = tokenizeCached(e.detail ?? "");
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
export function scoreBreakdown(e: BrainEpisode, query: string, filterTags?: string[]): { base:number; ageDays:number; halfLife:number; sourceBoost:number; final:number } {
  const base = scoreBase(e, query, filterTags);
  const ageDays = Math.max(0,(Date.now()-e.ts)/86400000);
  const halfLife = Math.pow(HALF_LIFE_FACTOR, ageDays/HALF_LIFE_DAYS);
  const sb = sourceBoost(e);
  return { base, ageDays: Math.round(ageDays*10)/10, halfLife: Math.round(halfLife*100)/100, sourceBoost: sb, final: Math.round(base*halfLife*sb*10)/10 };
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
function toksFor(e: BrainEpisode): Set<string> { return new Set([...tokenizeCached(e.cue), ...tokenizeCached(e.summary), ...tokenizeCached(e.detail??""), ...(e.tags??[]).map(t=>t.toLowerCase())]); }
export function indexEpisode(e: BrainEpisode) { for (const tok of toksFor(e)) { let set=brain.tokenIndex.get(tok); if(!set){ set=new Set(); brain.tokenIndex.set(tok,set); } set.add(e.id); } brain.memoGen++; brain.recallMemo.clear(); }
export function unindexEpisode(e: BrainEpisode) { for (const tok of toksFor(e)) { const set=brain.tokenIndex.get(tok); if(set){ set.delete(e.id); if(set.size===0) brain.tokenIndex.delete(tok); } } brain.memoGen++; brain.recallMemo.clear(); }
export function rebuildIndex(){ brain.tokenIndex.clear(); brain.memoGen++; brain.recallMemo.clear(); for(const e of brain.episodes.values()) indexEpisode(e); }
function archivePath(): string { return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain-archive.jsonl"); }
function archiveEpisodes(list: BrainEpisode[]) {
  if (!list.length) return;
  try { mkdirSync(dirname(archivePath()), { recursive: true }); for (const e of list) appendFileSync(archivePath(), JSON.stringify(e) + "\n", "utf8"); } catch {}
}
export function pruneExpired(pi: ExtensionAPI): number {
  const now=Date.now(); let n=0;
  const evicted: string[] = [];
  const toArchive: BrainEpisode[] = [];
  let evictedRemember = false;
  for(const [id,e] of brain.episodes) if(e.expiresAt&&e.expiresAt<now){ unindexEpisode(e); brain.episodes.delete(id); n++; evicted.push(id); toArchive.push(e); }
  while(brain.episodes.size>PRUNE_CAP){
    const sorted=[...brain.episodes.values()].sort((a,b)=>a.ts-b.ts);
    const oldest=sorted.find(e=>e.source==="auto")??sorted[0]; if(!oldest) break;
    if(oldest.source!=="auto") evictedRemember=true;
    if(oldest.source!=="auto") (pi as any).events?.emit?.("brain:overload",{evictRemember:oldest.cue,size:brain.episodes.size});
    unindexEpisode(oldest); brain.episodes.delete(oldest.id); n++; evicted.push(oldest.id); toArchive.push(oldest);
  }
  if (toArchive.length) archiveEpisodes(toArchive);
  if (n) { brain.stats.prune += n; (pi as any).events?.emit?.("brain:prune", { n, remaining: brain.episodes.size, evicted: evicted.slice(0,5), evictedRemember, archived: toArchive.length }); if (evictedRemember && isVerbose()) try{ (pi as any).events?.emit?.("brain:verbose", `prune evicted remember ${evicted[0]} → ${brain.episodes.size} left (archived)`);}catch{}
  }
  return n;
}
export function candidatePool(query: string): BrainEpisode[] {
  const qToks=expandTokens(tokenizeCached(query));
  if(qToks.length&&brain.tokenIndex.size){
    const idSets=qToks.map(t=>brain.tokenIndex.get(t)).filter(Boolean) as Set<string>[];
    if(idSets.length){
      const ids=new Set<string>(); for(const s of idSets) for(const id of s) ids.add(id);
      const hits=[...ids].map(id=>brain.episodes.get(id)).filter(Boolean) as BrainEpisode[];
      if(hits.length) return hits;
      // index miss: fast path — avoid scoring all 40 when we already know no token hit
      if (brain.episodes.size > 10) return [];
    }
  }
  return [...brain.episodes.values()];
}
