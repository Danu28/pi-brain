import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SIMILAR_COSINE } from "../knobs";
import { cosine, fromBase64, hashNeuralEmbed, toBase64 } from "../neural";
import { avgIdf, episodeTextForEmbedding, expandTokens, getEpisodeEmbedding, normalizeTags, scoreBase, tokenize } from "../scoring";
import { indexEpisode, unindexEpisode } from "../recall";
import { brain } from "../state";
import type { BrainEpisode } from "../types";
import { truncate } from "../util";

export function registerRemember(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Explicitly encode an episode to brain memory (hippocampus). Use cue as associative key. Audits before write: exact cue → upsert (always, force only bypasses similar audit), similar (score≥5) → preview + needs force:true. Supports tags (≤8 kebab) and refs (≤5 files).",
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
      // exact cue → upsert O(1) via exactCueIndex (A4 efficiency) — exact always upserts, force only bypasses similar audit
      const exactId = brain.exactCueIndex.get(cueNorm);
      const exact = exactId ? brain.episodes.get(exactId) : undefined;
      if (exact) {
        // upsert: update existing instead of creating duplicate
        unindexEpisode(exact);
        exact.summary = truncate(params.summary);
        if (params.detail) exact.detail = truncate(params.detail);
        if (tags) exact.tags = tags;
        if (refs) exact.refs = refs;
        exact.ts = Date.now();
        exact.source = "remember";
        delete (exact as any).expiresAt;
        // v2: re-embed on upsert
        try {
          const txt = episodeTextForEmbedding(exact);
          const vec = hashNeuralEmbed(txt);
          exact.embedding = toBase64(vec);
          brain.embeddings.set(exact.id, vec);
        } catch {}
        indexEpisode(exact);
        await (pi as any).appendEntry?.("brain:episode", exact);
        brain.episodes.set(exact.id, exact);
        brain.recallMemo.clear();
        (pi as any).events?.emit?.("brain:episode:encoded", exact);
        return { content: [{ type: "text", text: `Updated (audit: exact cue exists) ${exact.id} — was duplicate cue, merged instead of new` }], details: { id: exact.id, episode: exact, audit: "exact-cue-upsert" } };
      }
      // similarity audit: lexical (scoreBase*idf >=5) + semantic (cosine>SIMILAR_COSINE) — catches open vocab like ship→deploy
      const query = `${params.cue} ${params.summary}`;
      const terms = [...new Set(expandTokens(tokenize(query)))];
      const idf = avgIdf(terms);
      let qEmb: Float32Array | null = null;
      try { qEmb = hashNeuralEmbed(query); } catch { qEmb = null; }
      const scored = [...brain.episodes.values()]
        .filter((e) => e.source !== "auto")
        .map((e) => {
          const base = scoreBase(e, query, tags);
          const lex = base === 0 ? 0 : base * idf;
          let sem = 0;
          if (qEmb) {
            const docEmb = getEpisodeEmbedding(e);
            if (docEmb) sem = Math.max(0, cosine(qEmb, docEmb));
          }
          const s = Math.max(lex, sem >= SIMILAR_COSINE ? 6 : 0);
          return { e, s, lex, sem };
        })
        .filter((x) => x.s >= 5)
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, 3);
      if (scored.length && !params.force && !exact) {
        const preview = scored.map((x: any) => `[${x.e.cue}] ${x.e.summary} (score:${x.s.toFixed(1)} lex:${(x.lex ?? 0).toFixed(1)} sem:${(x.sem ?? 0).toFixed(2)})`).join("\n");
        return { content: [{ type: "text", text: `Audit: ${scored.length} similar episode(s) found — not encoded.\n${preview}\n→ To update existing, reuse its cue. To force new, call remember again with force:true` }], details: { audit: "similar-found", similar: scored.map((x: any) => ({ episode: x.e, score: x.s, sem: x.sem })), blocked: true } } as any;
      }
      const ep: BrainEpisode = {
        id: `${params.cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        cue: truncate(params.cue),
        summary: truncate(params.summary),
        detail: params.detail ? truncate(params.detail) : undefined,
        tags,
        refs,
        ts: Date.now(),
        source: "remember",
      };
      // v2: embed new episode (base64 for persistence + runtime cache)
      try {
        const txt = episodeTextForEmbedding(ep as BrainEpisode);
        const vec = hashNeuralEmbed(txt);
        ep.embedding = toBase64(vec);
        brain.embeddings.set(ep.id, vec);
      } catch {}
      await (pi as any).appendEntry?.("brain:episode", ep);
      brain.episodes.set(ep.id, ep);
      indexEpisode(ep);
      brain.recallMemo.clear();
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id}` }], details: { id: ep.id, episode: ep, audit: scored.length ? "forced" : "clean" } };
    },
  });
}