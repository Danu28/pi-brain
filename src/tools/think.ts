import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { brain } from "../state";
import type { Deliberation } from "../types";
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
      const entry: Deliberation = { goal: truncate(params.goal), hypotheses: params.hypotheses.map(truncate), conclusion: params.conclusion ? truncate(params.conclusion) : undefined, ts: Date.now() };
      brain.deliberations.push(entry);
      if (brain.deliberations.length > 10) brain.deliberations.shift();
      await (pi as any).appendEntry?.("brain:deliberation", entry);
      brain.thinkSatisfied = true;
      brain.needsDebugThink = false;
      if (wasDebug) { brain.needsPlanUpdate = true; brain.consecutiveFailures = 0; }
      (pi as any).events?.emit?.("brain:deliberation", entry);
      const hint = shortHyps.length ? `\n[hint: hypothesis "${shortHyps[0].slice(0,30)}" <10 chars — make it detailed (≥10) for better recall; plan will require 2-3 ≥10]` : "";
      const text = `Deliberation saved: ${params.goal}\n- ${params.hypotheses.join("\n- ")}${params.conclusion ? `\n=> ${params.conclusion}` : ""}${hint}`;
      return { content: [{ type: "text", text: truncate(text) }], details: { deliberation: entry, hint: shortHyps.length ? "short-hypothesis" : undefined } };
    },
  });
}