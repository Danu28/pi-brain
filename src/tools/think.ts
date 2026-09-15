import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchCode } from "../code";
import { createDeliberation } from "../deliberation";
import { rankedForQuery } from "../recall";
import { brain } from "../state";
import { truncate } from "../util";

export function registerThink(pi: ExtensionAPI) {
  pi.registerTool({
    name: "think",
    label: "Think",
    description: "PFC deliberation scratchpad: encode a reasoning step (goal + hypotheses) to working memory, injected next turn.",
    parameters: Type.Object({
      goal: Type.String({ description: "Reasoning goal or question" }),
      hypotheses: Type.Array(Type.String(), { description: "Hypotheses / approaches to consider", minItems: 1, maxItems: 3 }),
      conclusion: Type.Optional(Type.String({ description: "Tentative conclusion" })),
    }),
    async execute(_id, params, _signal) {
      if (brain.needsDebugThink && !params.goal.trim().toLowerCase().startsWith("debug")) {
        return { content: [{ type: "text", text: "Blocked: unhappy path requires think{goal:'debug <failed Task N>', hypotheses:[cause,fix]} — goal must start with 'debug'" }], details: { error: "debug required" } } as any;
      }
      // B6 alignment: think allows 1-3 (scratchpad lenient) but warn if <10 chars — plan requires 2-3 ≥10 strict. Hint helps recall relevance.
      const shortHyps = params.hypotheses.filter((h: string) => h.trim().length < 10);
      const wasDebug = brain.needsDebugThink;
      // D4 delegate to single owner createDeliberation (SRP)
      const entry = await createDeliberation(pi as any, params.goal, params.hypotheses, params.conclusion);
      brain.thinkSatisfied = true;
      brain.needsDebugThink = false;
      if (wasDebug) { brain.needsPlanUpdate = true; brain.consecutiveFailures = 0; }
      const hint = shortHyps.length ? `\n[hint: hypothesis "${shortHyps[0].slice(0,30)}" <10 chars — make it detailed (≥10) for better recall; plan will require 2-3 ≥10]` : "";
      // v2 P3 — retrieval-augmented: top3 episodes + top2 code for grounding
      let retrieval = "";
      try {
        const q = `${params.goal} ${params.hypotheses.join(" ")}`;
        const eps = rankedForQuery(q, 3);
        const code = brain.codeBlocks.length ? searchCode(q, 2).hits : [];
        if (eps.length || code.length) {
          const epLines = eps.length ? `Episodes:\n${eps.map(e=>`[${e.cue}] ${e.summary.slice(0,80)}`).join("\n")}` : "";
          const codeLines = code.length ? `Code:\n${code.map(h=>`${h.file}:${h.startLine} ${h.score.toFixed(2)} "${h.preview.slice(0,60)}"`).join("\n")}` : "";
          retrieval = `\n\n[retrieved ${eps.length} episodes + ${code.length} code — grounded]\n` + [epLines, codeLines].filter(Boolean).join("\n");
        }
      } catch {}
      const text = `Deliberation saved: ${params.goal}\n- ${params.hypotheses.join("\n- ")}${params.conclusion ? `\n=> ${params.conclusion}` : ""}${hint}${retrieval}`;
      return { content: [{ type: "text", text: truncate(text) }], details: { deliberation: entry, hint: shortHyps.length ? "short-hypothesis" : undefined } };
    },
  });
}