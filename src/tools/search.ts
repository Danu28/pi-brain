import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCodeIndex, formatCodeHits, searchCode } from "../code";
import { brain } from "../state";
import { truncate } from "../util";

export function registerSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: "Codebase search — hybrid hash-neural-384 + lexical (800-char chunks, 120 overlap). Offline, no grep, no vector DB. Use to find where/how code/details live in current codebase. Filter by filterPath substring.",
    parameters: Type.Object({
      query: Type.String({ description: "Code query e.g. 'where is auth handled', 'retry logic', 'payment validation'" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Max hits (default 5)" })),
      filterPath: Type.Optional(Type.String({ description: "Filter by path substring e.g. src/payments" })),
    }),
    async execute(_id, params, signal) {
      const query = (params as any).query as string;
      const limit = (params as any).limit ?? 5;
      const filterPath = (params as any).filterPath as string | undefined;

      if (!query?.trim()) {
        return { content: [{ type: "text", text: "Provide query e.g. search{query:\"where is auth handled\"}" }], details: {} } as any;
      }

      // auto-build index if empty and not already indexing
      if (!brain.codeBlocks.length && !brain.codeIndexing) {
        try {
          await buildCodeIndex(process.cwd(), signal as any).catch(() => {});
        } catch {}
      }

      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;

      const result = searchCode(query, Math.min(limit, 10), filterPath);

      // If still empty and we didn't index (e.g. large repo capped 500 files) — hint
      let text = formatCodeHits(query, result);
      if (!result.hits.length && result.totalBlocks === 0) {
        text += `\n\nHint: index empty — ensure cwd has files and retry. Blocks indexed: ${brain.codeBlocks.length}, indexing: ${brain.codeIndexing}`;
      } else if (filterPath && !result.hits.length) {
        text += `\nNo hits for filterPath "${filterPath}" — try without filterPath.`;
      }

      return {
        content: [{ type: "text", text: truncate(text) }],
        details: { hits: result.hits, model: result.model, totalBlocks: result.totalBlocks, query, filterPath } as any,
      };
    },
  });
}
