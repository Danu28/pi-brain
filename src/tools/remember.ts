import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandTokens, normalizeTags, scoreBase, tokenize } from "../scoring";
import { indexEpisode, unindexEpisode } from "../recall";
import { brain } from "../state";
import type { BrainEpisode } from "../types";
import { truncate } from "../util";

export function registerRemember(pi: ExtensionAPI) {
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
      // exact cue → upsert (no dup), reuse scoring for similarity check
      const exact = [...brain.episodes.values()].find((e) => e.cue.trim().toLowerCase() === cueNorm);
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
        brain.episodes.set(exact.id, exact);
        brain.recallMemo.clear();
        (pi as any).events?.emit?.("brain:episode:encoded", exact);
        return { content: [{ type: "text", text: `Updated (audit: exact cue exists) ${exact.id} — was duplicate cue, merged instead of new` }], details: { id: exact.id, episode: exact, audit: "exact-cue-upsert" } };
      }
      // similarity audit: decay-exempt (scoreBase) + IDF + source filter — 3→5 cuts false positives
      const query = `${params.cue} ${params.summary}`;
      const N = brain.episodes.size;
      const terms = [...new Set(expandTokens(tokenize(query)))];
      const scored = [...brain.episodes.values()]
        .filter((e) => e.source !== "auto")
        .map((e) => {
          const base = scoreBase(e, query, tags);
          if (base === 0) return { e, s: 0 };
          const idf = terms.length ? terms.map(t => Math.log((N+1)/((brain.tokenIndex.get(t)?.size ?? 0)+1))+1).reduce((a,b)=>a+b,0)/terms.length : 1;
          return { e, s: base * idf };
        })
        .filter((x) => x.s >= 5)
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, 3);
      if (scored.length && !params.force && !exact) {
        const preview = scored.map((x) => `[${x.e.cue}] ${x.e.summary} (score:${x.s.toFixed(1)})`).join("\n");
        return { content: [{ type: "text", text: `Audit: ${scored.length} similar episode(s) found — not encoded.\n${preview}\n→ To update existing, reuse its cue. To force new, call remember again with force:true` }], details: { audit: "similar-found", similar: scored.map((x) => ({ episode: x.e, score: x.s })), blocked: true } } as any;
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
      await (pi as any).appendEntry?.("brain:episode", ep);
      brain.episodes.set(ep.id, ep);
      indexEpisode(ep);
      brain.recallMemo.clear();
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id}` }], details: { id: ep.id, episode: ep, audit: scored.length ? "forced" : "clean" } };
    },
  });
}