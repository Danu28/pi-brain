import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { candidatePool } from "../recall";
import { gistForEpisode, scoreEpisode } from "../scoring";
import { brain } from "../state";
import type { BrainEpisode } from "../types";
import { truncate } from "../util";

const creativeThinkingParams = Type.Object({
  cues: Type.Array(Type.String(), { description: "2-3 cues to combine", minItems: 2, maxItems: 3 }),
  prompt: Type.Optional(Type.String({ description: "Synthesis prompt (e.g. approach to ...)" })),
});

async function creativeThinkingExecute(_id: any, params: any, signal: any) {
  if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;
  const pooled: BrainEpisode[] = [];
  for (const q of params.cues) {
    const hits = candidatePool(q)
      .map((e) => ({ e, s: scoreEpisode(e, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map((x) => x.e);
    pooled.push(...hits);
  }
  const unique = [...new Map(pooled.map((e) => [e.id, e])).values()].slice(0, 5);
  const recentThink = brain.deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n");
  if (!unique.length && !recentThink) return { content: [{ type: "text", text: "No episodes found for cues. Use remember first." }], details: { episodes: [] } };
  const thinkGoal = brain.deliberations[brain.deliberations.length-1]?.goal ?? "";
  const raw = params.prompt?.trim();
  const isLoose = !raw || raw.length < 15 || /^creative approach/i.test(raw);
  const synthesisPrompt = isLoose
    ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Create a novel approach combining: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
    : raw;
  const sources = unique.length ? `Sources:\n${unique.map((e) => `[${e.cue}] ${gistForEpisode(e)}`).join("\n")}` : "";
  const deliberationBlock = recentThink ? `Deliberation:\n${recentThink}` : "";
  const context = [sources, deliberationBlock].filter(Boolean).join("\n\n");
  const text = `${synthesisPrompt}\n\n${context}\n\n→ Combine insights: fuse episode patterns WITH deliberation hypotheses into variant not in either source.`;
  return { content: [{ type: "text", text: truncate(text) }], details: { episodes: unique, cues: params.cues, deliberation: recentThink || undefined } };
}

export function registerCreative(pi: ExtensionAPI) {
  pi.registerTool({
    name: "creative-thinking",
    label: "Creative Thinking",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach. Prompt e.g. 'creative-thinking neon + login into glass login' NOT vague 'creative approach' (loose auto-enriched). No vector DB.",
    parameters: creativeThinkingParams,
    async execute(_id, params, signal) { return creativeThinkingExecute(_id, params, signal); },
  });
}