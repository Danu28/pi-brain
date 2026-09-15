import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCodeIndex, formatCodeHits, searchCode } from "../code";
import { brain } from "../state";
import { truncate } from "../util";

export function registerSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: "Codebase search — hybrid hash-neural-384 + lexical (800-char chunks, 120 overlap). Offline, no grep, no vector DB. Use to find where/how code/details live. Batch: queries[] (≤5) for 1 call = N searches — prefer batch over N calls. Filter by filterPath substring.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Single query e.g. 'where is auth handled'" })),
      queries: Type.Optional(Type.Array(Type.String(), { description: "Batch queries (1 call = N searches, ≤5) — prefer this over N calls", maxItems: 5 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Max hits per query (default 5, batch merges to limit)" })),
      filterPath: Type.Optional(Type.String({ description: "Filter by path substring e.g. src/payments" })),
    }),
    async execute(_id, params, signal) {
      const limit = (params as any).limit ?? 5;
      const filterPath = (params as any).filterPath as string | undefined;
      const queries: string[] = (params as any).queries?.length ? (params as any).queries : [(params as any).query ?? ""];
      const cleanQueries = queries.map((q) => String(q).trim()).filter(Boolean);
      if (!cleanQueries.length) {
        return { content: [{ type: "text", text: "Provide query e.g. search{query:\"where is auth handled\"} or search{queries:[\"auth\",\"retry\"]}" }], details: {} } as any;
      }

      // auto-build index if empty
      if (!brain.codeBlocks.length && !brain.codeIndexing) {
        try {
          await buildCodeIndex(process.cwd(), signal as any).catch(() => {});
        } catch {}
      } else {
        // within-session freshness: sync before search if dirty/stale (no restart needed)
        try {
          if (!brain.codeIndexing) {
            const last = brain.codeIndexStats.lastIndexedAt ?? 0;
            const stale = Date.now() - last > 30_000;
            if (brain.hasWriteEdit || stale) {
              const { syncCodeIndex } = await import("../code.js");
              await (syncCodeIndex as any)(process.cwd(), signal as any).catch(() => {});
              brain.hasWriteEdit = false;
            }
          }
        } catch {}
      }
      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;

      // batch: 1 call = N searches
      const perQuery: Record<string, ReturnType<typeof searchCode>["hits"]> = {} as any;
      const mergedMap = new Map<string, ReturnType<typeof searchCode>["hits"][number]>();
      let totalBlocks = 0;
      let model = "hash-neural-384";
      for (const q of cleanQueries) {
        const result = searchCode(q, Math.min(limit, 10), filterPath);
        totalBlocks = result.totalBlocks;
        model = result.model;
        perQuery[q] = result.hits;
        for (const h of result.hits) {
          const key = `${h.file}:${h.startLine}`;
          const existing = mergedMap.get(key);
          if (!existing || h.score > existing.score) mergedMap.set(key, h as any);
        }
        if (signal?.aborted) break;
      }

      const merged = [...mergedMap.values()].sort((a, b) => b.score - a.score).slice(0, Math.min(limit * (cleanQueries.length > 1 ? 2 : 1), 10));

      // format output: merged top + perQuery breakdown
      let text = "";
      if (cleanQueries.length === 1) {
        const single = searchCode(cleanQueries[0], Math.min(limit, 10), filterPath);
        text = formatCodeHits(cleanQueries[0], single);
      } else {
        const lines: string[] = [`🔍 Code batch — ${cleanQueries.length} queries — merged top ${merged.length} (of ${totalBlocks} blocks, model: ${model})`];
        for (let i = 0; i < merged.length; i++) {
          const h = merged[i];
          const bar = "█".repeat(Math.round(h.score * 10)) + "░".repeat(10 - Math.round(h.score * 10));
          lines.push(`${i + 1}. ${h.file}:${h.startLine} ${h.score.toFixed(3)} ${bar}`);
          lines.push(`   "${h.preview}"`);
        }
        lines.push("");
        for (const q of cleanQueries) {
          const hits = perQuery[q];
          lines.push(`— "${q}" → ${hits.length} hits`);
          for (let i = 0; i < Math.min(2, hits.length); i++) lines.push(`  ${i + 1}. ${hits[i].file}:${hits[i].startLine} ${hits[i].score.toFixed(3)}`);
        }
        text = lines.join("\n");
        if (text.length > 4000) text = text.slice(0, 4000) + "\n… truncated";
      }

      if (!merged.length && totalBlocks === 0) {
        text += `\n\nHint: index empty — ensure cwd has files and retry. Blocks indexed: ${brain.codeBlocks.length}, indexing: ${brain.codeIndexing}`;
      } else if (filterPath && !merged.length) {
        text += `\nNo hits for filterPath "${filterPath}" — try without filterPath.`;
      }

      return {
        content: [{ type: "text", text: truncate(text) }],
        details: { hits: merged, perQuery: cleanQueries.length > 1 ? perQuery : undefined, model, totalBlocks, queries: cleanQueries, filterPath } as any,
      };
    },
  });
}
