import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRUNE_CAP } from "./knobs";
import { avgIdf, expandTokens, scoreEpisode, tokenize } from "./scoring";
import { brain } from "./state";
import type { BrainEpisode } from "./types";

export function indexEpisode(e: BrainEpisode) {
  const toks = new Set([...tokenize(e.cue), ...tokenize(e.summary), ...tokenize(e.detail ?? ""), ...(e.tags ?? []).map(t=>t.toLowerCase())]);
  for (const tok of toks) {
    let set = brain.tokenIndex.get(tok);
    if (!set) { set = new Set(); brain.tokenIndex.set(tok, set); }
    set.add(e.id);
  }
  // A4 exact-cue O(1) index
  brain.exactCueIndex.set(e.cue.trim().toLowerCase(), e.id);
}

export function unindexEpisode(e: BrainEpisode) {
  const toks = new Set([...tokenize(e.cue), ...tokenize(e.summary), ...tokenize(e.detail ?? ""), ...(e.tags ?? []).map(t=>t.toLowerCase())]);
  for (const tok of toks) {
    const set = brain.tokenIndex.get(tok);
    if (set) { set.delete(e.id); if (set.size === 0) brain.tokenIndex.delete(tok); }
  }
  const cueNorm = e.cue.trim().toLowerCase();
  if (brain.exactCueIndex.get(cueNorm) === e.id) brain.exactCueIndex.delete(cueNorm);
}

export function rebuildIndex() {
  brain.tokenIndex.clear();
  brain.exactCueIndex.clear();
  for (const e of brain.episodes.values()) indexEpisode(e);
}

// T2 prune expired auto episodes
export function pruneExpired(pi: ExtensionAPI): number {
  const now = Date.now();
  let n = 0;
  for (const [id,e] of brain.episodes) {
    if (e.expiresAt && e.expiresAt < now) {
      unindexEpisode(e);
      brain.episodes.delete(id);
      n++;
    }
  }
  // prune also clears exactCue via unindexEpisode
  if (n) {
    // clear memo on prune
    brain.recallMemo.clear();
  }
  // M2: LRU eviction if still over cap — delete oldest auto then oldest overall (warn if evicting remember)
  while (brain.episodes.size > PRUNE_CAP) {
    const sorted = [...brain.episodes.values()].sort((a,b)=>a.ts-b.ts);
    const oldest = sorted.find(e=>e.source==="auto") ?? sorted[0];
    if (!oldest) break;
    if (oldest.source !== "auto") (pi as any).events?.emit?.("brain:overload", { evictRemember: oldest.cue, size: brain.episodes.size });
    unindexEpisode(oldest);
    brain.episodes.delete(oldest.id);
    n++;
    brain.recallMemo.clear();
  }
  return n;
}

// B2 helper: ranked query — single place for avgIdf + scoreEpisode + limit (used by recall + creative)
export function rankedForQuery(query: string, limit: number, filterTags?: string[]): BrainEpisode[] {
  const terms = [...new Set(expandTokens(tokenize(query)))];
  const idf = avgIdf(terms);
  return candidatePool(query)
    .map((e) => ({ e, s: scoreEpisode(e, query, filterTags as any) * idf }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
    .slice(0, limit)
    .map((x) => x.e);
}

// Candidate pool for a token query — index hits, else full scan (O(n) fallback)
export function candidatePool(query: string): BrainEpisode[] {
  const qToks = expandTokens(tokenize(query));
  if (qToks.length && brain.tokenIndex.size) {
    const idSets = qToks.map(t => brain.tokenIndex.get(t)).filter(Boolean) as Set<string>[];
    if (idSets.length) {
      const ids = new Set<string>();
      for (const s of idSets) for (const id of s) ids.add(id);
      const hits = [...ids].map(id => brain.episodes.get(id)).filter(Boolean) as BrainEpisode[];
      if (hits.length) return hits;
    }
  }
  return [...brain.episodes.values()];
}