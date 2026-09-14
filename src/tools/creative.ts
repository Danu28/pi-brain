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
    // deliberation-only: 1 layer on think — no episodes, force divergent variants + warning
    const thinkGoal = brain.deliberations[brain.deliberations.length-1]?.goal ?? "";
    const raw = params.prompt?.trim();
    const isLoose = !raw || raw.length < 15 || /^creative approach/i.test(raw);
    const synthesisPrompt = isLoose
      ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Create a novel variant from think: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
      : raw;
    const deliberationBlock = `Deliberation:\n${recentThink}`;
    const warning = `⚠️ [low-value warning: deliberation-only — no episodes matched cues "${params.cues.join(", ")}" — this is paraphrasing think; real value comes from think × episodes. For CRUD, skip creative-thinking and improve think instead.]`;
    const variants = `→ Produce 3 forced variants (each must be concrete and NOT verbatim in Deliberation):\n1. [Substitute] Twist one hypothesis by substituting its core material/mechanism — Title | How it works | Why novel vs think\n2. [Combine] Merge two hypotheses into a hybrid with interaction effect — Title | How it works | Why novel vs think\n3. [Invert/Exaggerate] Invert or 10× exaggerate a constraint from think — Title | How it works | Why novel vs think\nConstraint: pick exactly ONE next → plan; if none excite, improve think instead of forcing creativity.`;
    const text = `${warning}\n\n${synthesisPrompt}\n\n${deliberationBlock}\n\n${variants}`;
    return { content: [{ type: "text", text: truncate(text) }], details: { episodes: [], cues: params.cues, deliberation: recentThink, mode: "deliberation-only", warning: "low-value" } };
  }
  const thinkGoal = brain.deliberations[brain.deliberations.length-1]?.goal ?? "";
  const raw = params.prompt?.trim();
  const isLoose = !raw || raw.length < 15 || /^creative approach/i.test(raw);
  const synthesisPrompt = isLoose
    ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Create a novel approach combining: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
    : raw;
  const sources = `Sources:\n${unique.map((e) => `[${e.cue}] ${gistForEpisode(e)}`).join("\n")}`;
  const deliberationBlock = `Deliberation:\n${recentThink}`;
  const variants = `→ Produce 3 forced FUSED variants (each NOT in think nor episodes alone):\n1. [Fuse H1 × Episode] Combine strongest think hypothesis with episode pattern — Title | Fusion | Why novel\n2. [Fuse H2 × Episode] Combine second hypothesis with different episode pattern — Title | Fusion | Why novel\n3. [Anti-pattern / Contrarian] Invert the fused consensus to break fixation — Title | Inversion | Why novel\nConstraint: each variant must cite which think hypothesis + which episode it fuses.`;
  const text = `${synthesisPrompt}\n\n${sources}\n\n${deliberationBlock}\n\n${variants}`;
  return { content: [{ type: "text", text: truncate(text) }], details: { episodes: unique, cues: params.cues, deliberation: recentThink, mode: "fused" } };
}

export function registerCreative(pi: ExtensionAPI) {
  pi.registerTool({
    name: "creative-thinking",
    label: "Creative Thinking",
    description: "Post-think creative layer: 1 layer on top of think — takes latest think {goal, hypotheses} + optional cues[2..3] episodes → 3 forced variants not in think/episodes alone. Episodes are optional enhancement (fused if recall hits, else SCAMPER + low-value warning). STRICTLY after think (reads deliberations[-1]; hint if missing). Variants: 1=Substitute, 2=Combine, 3=Invert/Anti-pattern. Prompt e.g. 'neon + login → glass login' NOT 'creative approach'. No vector DB.",
    parameters: creativeThinkingParams,
    async execute(_id, params, signal) { return creativeThinkingExecute(_id, params, signal); },
  });
}