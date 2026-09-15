import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTO_BOOST, AUTO_TTL_MS, BLEND_LEXICAL, BLEND_SEMANTIC, BLEND_TAG, BUDGET_STOP_PCT, BUDGET_WARN_PCT, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, MAX_BYTES, MAX_LINES, NEURAL_DIM, NEURAL_SEED, PRUNE_CAP, PRUNE_WARN, REMEMBER_BOOST, SIMILAR_COSINE, TAG_BOOST } from "../knobs";
import { cosine } from "../neural";
import { getEpisodeEmbedding } from "../scoring";
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
      const codeAge = brain.codeIndexStats.lastIndexedAt ? `${Math.round((Date.now()-brain.codeIndexStats.lastIndexedAt)/60000)}m ago` : "never";
      const neuralInfo = `Neural: ${brain.neuralModel} ${NEURAL_DIM}d seed:${NEURAL_SEED} vecs:${vecs}/${count} blend:${BLEND_LEXICAL}/${BLEND_SEMANTIC}/${BLEND_TAG} sim:${SIMILAR_COSINE}`;
      const codeInfo = `Code: ${brain.codeIndexStats.blocks} blocks ${brain.codeIndexStats.files} files synced ${codeAge} ${brain.codeIndexing?"(indexing)":""}`;
      const idxStats = `Index: ${brain.tokenIndex.size} tokens → ${count} episodes (${remCount} remember, ${autoCount} auto) | cueIndex:${brain.exactCueIndex.size} | memo hits:${brain.memoHits} miss:${brain.memoMisses} | ${neuralInfo} | ${codeInfo}`;
      // v2 P3 — habit cluster suggestion (brute pairwise cosine >SIMILAR_COSINE, no lib, <5ms for 40 eps)
      let habitHint = "";
      try {
        const autos = [...brain.episodes.values()].filter(e=>e.source==="auto" && getEpisodeEmbedding(e));
        if (autos.length >= 5) {
          const groups: typeof autos[] = [];
          const used = new Set<string>();
          for (const a of autos) {
            if (used.has(a.id)) continue;
            const embA = getEpisodeEmbedding(a);
            if (!embA) continue;
            const g: typeof autos = [a];
            used.add(a.id);
            for (const b of autos) {
              if (used.has(b.id)) continue;
              const embB = getEpisodeEmbedding(b);
              if (!embB) continue;
              if (cosine(embA, embB) > SIMILAR_COSINE) { g.push(b); used.add(b.id); }
            }
            if (g.length > 1) groups.push(g);
          }
          const biggest = groups.sort((a,b)=>b.length-a.length)[0];
          if (biggest && biggest.length >= 5) {
            const cue = biggest[0].cue.slice(0,30).replace(/[^a-z0-9-]/gi,"-").toLowerCase();
            habitHint = `\nHabit suggestion: cluster "${biggest[0].cue.slice(0,30)}" x${biggest.length} — run habit {name:"${cue}", when:"Use when ${biggest[0].cue.slice(0,50)}", steps:"..."}`;
          } else if (autos.length >= 8) {
            habitHint = `\nHabit hint: ${autos.length} auto episodes — consider habit if repeating "${autos[0].cue.slice(0,30)}"`;
          }
        }
      } catch {}
      const gistPreview = [...brain.episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map(gistForEpisode).join(" | ");
      const gistTokens = estTokens(gistPreview);
      const knobs = `Knobs: MAX_BYTES=${MAX_BYTES} MAX_LINES=${MAX_LINES} TAG_BOOST=${TAG_BOOST} HALF_LIFE=${HALF_LIFE_FACTOR}/${HALF_LIFE_DAYS}d REMEMBER_BOOST=${REMEMBER_BOOST} AUTO_BOOST=${AUTO_BOOST} TTL=${AUTO_TTL_MS/86400000}d PRUNE_WARN=${PRUNE_WARN} PRUNE_CAP=${PRUNE_CAP} BUDGET=${BUDGET_WARN_PCT}/${BUDGET_STOP_PCT}% | NEURAL_DIM=${NEURAL_DIM} BLEND=${BLEND_LEXICAL}/${BLEND_SEMANTIC}/${BLEND_TAG} SIM=${SIMILAR_COSINE}`;
      const budget = pct !== undefined ? `Budget: ${pct}% ${pct>BUDGET_STOP_PCT?"(STOP inject)":pct>BUDGET_WARN_PCT?"(warn: inject 1)":""}` : `Budget: est ${gistTokens} tokens gist`;
      const txt = `Episodes: ${count} (${remCount} remember, ${autoCount} auto)\nTokens: ${usage?.used ?? "?"} / ${usage?.total ?? "?"}${pct !== undefined ? ` (${pct}%)` : ""}${overloaded ? "\n[overload: consider compaction/pruning]" : ""}\nDeliberations: ${brain.deliberations.length}\n${idxStats}\nGist preview (${gistTokens} tok): ${gistPreview.slice(0,120)}\n${knobs}\n${budget}${habitHint}`;
      return { content: [{ type: "text", text: txt }], details: { episodes: count, autoCount, remCount, tokens: usage, recent: [...brain.episodes.values()].slice(-3), overloaded, deliberations: brain.deliberations.slice(-3), habitHint: habitHint || undefined, index: { tokens: brain.tokenIndex.size, episodes: count, memoHits: brain.memoHits, memoMisses: brain.memoMisses, exactCueIndex: brain.exactCueIndex.size, vecs, codeBlocks: brain.codeIndexStats.blocks }, knobs: { MAX_BYTES, MAX_LINES, TAG_BOOST, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, REMEMBER_BOOST, AUTO_BOOST, PRUNE_WARN, PRUNE_CAP, BUDGET_WARN_PCT, BUDGET_STOP_PCT, AUTO_TTL_MS, NEURAL_DIM, BLEND_LEXICAL, BLEND_SEMANTIC, SIMILAR_COSINE } } };
    },
  });
}
