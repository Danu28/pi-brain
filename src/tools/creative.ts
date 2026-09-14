import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { candidatePool } from "../recall";
import { avgIdf, expandTokens, gistForEpisode, scoreEpisode, tokenize } from "../scoring";
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
    const terms = [...new Set(expandTokens(tokenize(q)))];
    const idf = avgIdf(terms);
    const hits = candidatePool(q)
      .map((e) => ({ e, s: scoreEpisode(e, q) * idf }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map((x) => x.e);
    pooled.push(...hits);
  }
  const unique = [...new Map(pooled.map((e) => [e.id, e])).values()].slice(0, 5);
  const recentThink = brain.deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n");
  if (!recentThink) {
    // strict sequencing: creative-thinking must follow think — surface hint but still allow synthesis from episodes alone
    const hint = "[hint: creative-thinking is post-think — call think{goal, hypotheses} first so synthesis fuses hypotheses × episodes; proceeding with episodes only]\n";
    if (!unique.length) return { content: [{ type: "text", text: "No episodes found for cues and no think yet. Call think first, then creative-thinking with 2-3 cues." }], details: { episodes: [] } };
    const thinkGoal2 = brain.deliberations[brain.deliberations.length-1]?.goal ?? "";
    const raw2 = params.prompt?.trim();
    const isLoose2 = !raw2 || raw2.length < 15 || /^creative approach/i.test(raw2);
    const synthesisPrompt2 = isLoose2 ? (raw2 ? `${raw2} — fuse ${params.cues.join(" + ")}${thinkGoal2 ? ` + think: ${thinkGoal2}` : ""}` : `Create a novel approach combining: ${params.cues.join(" + ")}`) : raw2;
    const sources2 = unique.length ? `Sources:\n${unique.map((e) => `[${e.cue}] ${gistForEpisode(e)}`).join("\n")}` : "";
    const text2 = `${hint}${synthesisPrompt2}\n\n${sources2}\n\n→ Call think first, then re-run creative-thinking to fuse hypotheses × episodes into a variant not in either source.`;
    return { content: [{ type: "text", text: truncate(text2) }], details: { episodes: unique, cues: params.cues, hint: "missing-think" } };
  }
  if (!unique.length) {
    // deliberation-only mode: creative layer on top of think — episodes are optional enhancement
    const thinkGoal = brain.deliberations[brain.deliberations.length-1]?.goal ?? "";
    const raw = params.prompt?.trim();
    const isLoose = !raw || raw.length < 15 || /^creative approach/i.test(raw);
    const synthesisPrompt = isLoose
      ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Create a novel variant from think: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
      : raw;
    const deliberationBlock = `Deliberation:\n${recentThink}`;
    const text = `${synthesisPrompt}\n\n${deliberationBlock}\n\n[deliberation-only: no episodes matched cues — synthesizing 1 layer on top of think hypotheses into novel variant]\n\n→ Creative layer: recombine + twist think hypotheses into variant not in deliberation alone (episodes would enhance if present).`;
    return { content: [{ type: "text", text: truncate(text) }], details: { episodes: [], cues: params.cues, deliberation: recentThink, mode: "deliberation-only" } };
  }
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
    description: "Post-think creative layer: 1 layer on top of think — takes latest think {goal, hypotheses} + optional cues[2..3] episodes → novel variant not in think alone. Episodes are optional enhancement (fused if recall hits, otherwise deliberation-only). STRICTLY after think (reads deliberations[-1]; hint if missing). Prompt e.g. 'neon + login → glass login' NOT 'creative approach' (loose auto-enriched with cues+think goal). No vector DB.",
    parameters: creativeThinkingParams,
    async execute(_id, params, signal) { return creativeThinkingExecute(_id, params, signal); },
  });
}