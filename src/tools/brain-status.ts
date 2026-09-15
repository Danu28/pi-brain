import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTO_BOOST, AUTO_TTL_MS, BLEND_LEXICAL, BLEND_SEMANTIC, BLEND_TAG, BUDGET_STOP_PCT, BUDGET_WARN_PCT, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, MAX_BYTES, MAX_LINES, NEURAL_DIM, NEURAL_SEED, PRUNE_CAP, PRUNE_WARN, REMEMBER_BOOST, SIMILAR_COSINE, TAG_BOOST } from "../knobs";
// C5/C6 bucket C: overload uses PRUNE_CAP, prune transparency via exactCueIndex + memo stats
import { estTokens, gistForEpisode } from "../gist";
import { brain } from "../state";

export function registerBrainStatus(pi: ExtensionAPI) {
  pi.registerTool({
    name: "brain-status",
    label: "Brain status",
    description: "How full is the brain? Episode count + context usage (metacognition). Emits brain:overload if >80%. Shows index stats + calibration knobs.",
    parameters: Type.Object({}),
    async execute(_id, _p, _sig, _upd, ctx: any) {
      let usage: any = undefined;
      try {
        usage = ctx?.getContextUsage?.() ?? (pi as any).getContextUsage?.() ?? undefined;
      } catch {}
      const count = brain.episodes.size;
      const autoCount = [...brain.episodes.values()].filter(e=>e.source==="auto").length;
      const remCount = count - autoCount;
      const pct = usage?.percent ?? (usage?.used && usage?.total ? Math.round((usage.used / usage.total) * 100) : undefined);
      // C5: honest overload — PRUNE_CAP 40 not 50 (would never fire) + pct>80
      const overloaded = (pct !== undefined && pct > 80) || count > PRUNE_CAP;
      if (overloaded) (pi as any).events?.emit?.("brain:overload", { episodes: count, percent: pct });
      // C6 prune transparency + v2 neural stats
      const vecs = [...brain.episodes.values()].filter(e=>!!e.embedding).length;
      const neuralInfo = `Neural: ${brain.neuralModel} ${NEURAL_DIM}d seed:${NEURAL_SEED} vecs:${vecs}/${count} blend:${BLEND_LEXICAL}/${BLEND_SEMANTIC}/${BLEND_TAG} sim:${SIMILAR_COSINE}`;
      const idxStats = `Index: ${brain.tokenIndex.size} tokens → ${count} episodes (${remCount} remember, ${autoCount} auto) | cueIndex:${brain.exactCueIndex.size} | memo hits:${brain.memoHits} miss:${brain.memoMisses} | ${neuralInfo}`;
      const gistPreview = [...brain.episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map(gistForEpisode).join(" | ");
      const gistTokens = estTokens(gistPreview);
      const knobs = `Knobs: MAX_BYTES=${MAX_BYTES} MAX_LINES=${MAX_LINES} TAG_BOOST=${TAG_BOOST} HALF_LIFE=${HALF_LIFE_FACTOR}/${HALF_LIFE_DAYS}d REMEMBER_BOOST=${REMEMBER_BOOST} AUTO_BOOST=${AUTO_BOOST} TTL=${AUTO_TTL_MS/86400000}d PRUNE_WARN=${PRUNE_WARN} PRUNE_CAP=${PRUNE_CAP} BUDGET=${BUDGET_WARN_PCT}/${BUDGET_STOP_PCT}% | NEURAL_DIM=${NEURAL_DIM} BLEND=${BLEND_LEXICAL}/${BLEND_SEMANTIC}/${BLEND_TAG} SIM=${SIMILAR_COSINE}`;
      const budget = pct !== undefined ? `Budget: ${pct}% ${pct>BUDGET_STOP_PCT?"(STOP inject)":pct>BUDGET_WARN_PCT?"(warn: inject 1)":""}` : `Budget: est ${gistTokens} tokens gist`;
      const txt = `Episodes: ${count} (${remCount} remember, ${autoCount} auto)\nTokens: ${usage?.used ?? "?"} / ${usage?.total ?? "?"}${pct !== undefined ? ` (${pct}%)` : ""}${overloaded ? "\n[overload: consider compaction/pruning]" : ""}\nDeliberations: ${brain.deliberations.length}\n${idxStats}\nGist preview (${gistTokens} tok): ${gistPreview.slice(0,120)}\n${knobs}\n${budget}`;
      return { content: [{ type: "text", text: txt }], details: { episodes: count, autoCount, remCount, tokens: usage, recent: [...brain.episodes.values()].slice(-3), overloaded, deliberations: brain.deliberations.slice(-3), index: { tokens: brain.tokenIndex.size, episodes: count, memoHits: brain.memoHits, memoMisses: brain.memoMisses, exactCueIndex: brain.exactCueIndex.size }, knobs: { MAX_BYTES, MAX_LINES, TAG_BOOST, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, REMEMBER_BOOST, AUTO_BOOST, PRUNE_WARN, PRUNE_CAP, BUDGET_WARN_PCT, BUDGET_STOP_PCT, AUTO_TTL_MS } } };
    },
  });
}