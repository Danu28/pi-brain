import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BLEND_SEMANTIC, RECALL_MEMO_MS } from "../knobs";
import { hashNeuralEmbed } from "../neural";
import { avgIdf, expandTokens, hybridScore, normalizeTags, parseSince, scoreEpisode, tokenize } from "../scoring";
import { brain } from "../state";
import type { BrainEpisode } from "../types";
import { truncate } from "../util";

export function registerRecall(pi: ExtensionAPI) {
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
      const queries: string[] = params.queries?.length ? params.queries : [params.query ?? ""];
      // T9 memo key (normalize tags for stable key)
      const normTags = normalizeTags(params.tags as any);
      const memoKey = `${queries.join("\x00")}|${(normTags??[]).join(",")}|${params.source??""}|${params.since??""}|${limit}`; // \x00 avoids a+b collision
      const cached = brain.recallMemo.get(memoKey);
      if (cached && Date.now() - cached.ts < RECALL_MEMO_MS) {
        brain.memoHits++;
        // true LRU — move to tail
        brain.recallMemo.delete(memoKey); brain.recallMemo.set(memoKey, cached);
        if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;
        return { content: [{ type: "text", text: truncate(cached.text) }], details: { episodes: cached.ranked, perQuery: (cached as any).perQuery, cached: true } };
      }
      const filterTags = normTags;
      const sinceTs = parseSince(params.since as any);
      let candidates: BrainEpisode[] = [...brain.episodes.values()];
      // batch queries: union tokens and max score across queries (1 call = N recalls) — single terms compute (DRY)
      const terms = [...new Set(queries.flatMap(q => expandTokens(tokenize(q))))];
      if (terms.length && brain.tokenIndex.size) {
        const idSets = terms.map(t => brain.tokenIndex.get(t)).filter(Boolean) as Set<string>[];
        if (idSets.length) {
          const hitIds = new Set<string>();
          for (const s of idSets) for (const id of s) hitIds.add(id);
          // proper tag union using normalized
          if (filterTags?.length) {
            for (const e of brain.episodes.values()) {
              const eNorm = normalizeTags(e.tags) ?? [];
              if (filterTags.some(ft => eNorm.includes(ft))) hitIds.add(e.id);
            }
          }
          const hits = [...hitIds].map(id => brain.episodes.get(id)).filter(Boolean) as BrainEpisode[];
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
      const idf = avgIdf(terms);
      // v2 hybrid: precompute qEmb per query + maxLex per query for normLex (BLEND_SEMANTIC=0 → pure lexical v1)
      const qEmbs: (Float32Array | null)[] = queries.map(q => {
        if (!q.trim() || BLEND_SEMANTIC === 0) return null;
        try { return hashNeuralEmbed(q); } catch { return null; }
      });
      const perQueryMaxLex: number[] = queries.map((q, qi) => {
        if (!q.trim()) return 1;
        const qIdf = avgIdf([...new Set(expandTokens(tokenize(q)))]);
        const lex = candidates.map(e => scoreEpisode(e, q, filterTags) * qIdf);
        return Math.max(1, ...lex);
      });
      const maxLex = Math.max(1, ...perQueryMaxLex);
      // A3 DRY + B3 tag-only preserved
      const scored = candidates
        .map((e) => {
          const scores = queries.map((q, qi) => {
            const qIdf = qi < perQueryMaxLex.length ? avgIdf([...new Set(expandTokens(tokenize(q)))]) : idf;
            return hybridScore(e, q, filterTags, qEmbs[qi] as any, perQueryMaxLex[qi] ?? maxLex, qIdf);
          });
          const raw = Math.max(...scores);
          if (raw === 0) return { e, s: 0 };
          return { e, s: raw };
        })
        .filter((x) => x.s > 0 || queries.every(q => q.trim() === "") || (filterTags?.length ? true : false))
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, limit)
        .map((x) => x.e);

      const ranked = scored.length ? scored : candidates.sort((a, b) => b.ts - a.ts).slice(0, limit);
      // A1 batch per-query details: 1 call = N but exposes per-query top-3 (keeps union max-score for main ranking)
      const perQuery: Record<string, BrainEpisode[]> = {};
      if (queries.length > 1) {
        for (const q of queries) {
          if (!q.trim()) continue;
          const qTerms = [...new Set(expandTokens(tokenize(q)))];
          const qIdf = avgIdf(qTerms);
          let qEmbPer: Float32Array | null = null;
          if (BLEND_SEMANTIC > 0 && q.trim()) try { qEmbPer = hashNeuralEmbed(q); } catch { qEmbPer = null; }
          const qMaxLex = Math.max(1, ...candidates.map(e => scoreEpisode(e, q, filterTags) * qIdf));
          const qScored = candidates
            .map((e) => {
              const s = hybridScore(e, q, filterTags, qEmbPer as any, qMaxLex, qIdf);
              if (s === 0) return { e, s: 0 };
              return { e, s };
            })
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
            .slice(0, Math.min(3, limit))
            .map((x) => x.e);
          perQuery[q] = qScored.length ? qScored : [];
        }
      }
      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;

      // T8 smart detail slicing: keep full for explicit recall, but truncate gist for display
      const text = ranked.length
        ? ranked.map((e) => `[${e.cue}]${e.tags?.length ? ` [${e.tags.join(",")}]` : ""} ${e.summary}${e.detail ? " — " + e.detail.slice(0, 120) : ""}${e.refs?.length ? ` refs:${e.refs.join(",")}` : ""}`).join("\n")
        : "No episodes yet. Use remember to encode.";
      // store memo (includes perQuery for A1)
      brain.memoMisses++;
      brain.recallMemo.set(memoKey, { ts: Date.now(), ranked, text, perQuery: Object.keys(perQuery).length ? perQuery : undefined } as any);
      // cap memo size
      if (brain.recallMemo.size > 50) {
        const first = brain.recallMemo.keys().next().value;
        if (first) brain.recallMemo.delete(first);
      }
      return { content: [{ type: "text", text: truncate(text) }], details: { episodes: ranked, perQuery: Object.keys(perQuery).length ? perQuery : undefined } };
    },
  });
}