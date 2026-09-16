import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain, latestPlan, renderPlan } from "./state";

// Clean inject — no hidden auto-recall, no budgetTrim, no episode injection.
// User sees exactly what happens: recall must be called explicitly, episodes never appear without recall tool.
// Only stable prefix + explicit recall nudge + deliberation + plan are injected.

const STRICT_STABLE_PREFIX = `[STRICT BRAIN MODE ON — 7 RULES ENFORCED]
Happy (2-call floor): recall (top-3) → think (smart reads) → [creative-thinking if novel] → plan #1 → Turn1 read×N parallel → Turn2 edit×N+write×N+bash verify parallel → plan #2 done:[all] → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')
Unhappy (3-call floor): same but 3 plan calls — plan #1 → failure → think{goal:"debug <failed Task N>", hypotheses:[root cause, fix]} → plan #2 → retry Turn1/Turn2 → plan #3 done:[all] → remember → habit → git commit. Execution blocked until debug-think done.
Batch: 1 LLM call = N tool calls. Turn1: read×N parallel; Turn2: edit×N+write×N+bash parallel. Chunk edits: 1 edit per file, exact oldText, merge nearby changes. If oldText known → skip reads → 1 call. Record → 0-call replay. Prefer plan{hypotheses} single-shot (think+plan 2→1). 5-Step: Question→Delete→Simplify→Accelerate→Automate.

1. Recall-first: call recall{query} first (explicit) — no episodes injected automatically. Cite cue(s) when episodes exist.
2. Think-before-act: think MUST smart-read required relevant files first, then call think{goal,hypotheses} — ensure all info needed to finish task is gathered BEFORE plan (enforced — write will be blocked otherwise; no broad reading, only relevant files).
3. Creative-thinking-only-for-novelty: call creative-thinking when task is creative/novel (e.g. "creative login", "novel approach"), SKIP for CRUD/bugfix — do this BEFORE planning to get all inputs.
4. Plan-after-inputs: after think (+ creative-thinking if novel) → plan #1 creates [ ] checklist; final update is plan #2 done:[0,1,...] batch all (no incremental). Unhappy: plan #2 after debug think, plan #3 final batch. Execution is batched: Turn1 read×N, Turn2 edit×N+write×N+bash.
5. Shortest-diff + Batch: Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel, 1 edit per file with exact oldText, no scaffolding for later. Bash verify after edits land (not same call as edit it checks).
6. Encode: after every successful write/edit/bash you MUST call remember{cue,summary}; 2nd repeat of same fix → habit{name,when,steps}.
7. Git: when plan 2/2 done + remember done, bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>' (skip if no changes).

Pi Tools — use exactly as defined:
- read {path, offset?, limit?} — read text/image, truncated 50KB/2000 lines; large files via offset/limit
- write {path, content} — create/overwrite, auto-creates parent dirs
- edit {path, edits:[{oldText,newText}]} — exact unique oldText, non-overlapping, merge nearby changes, one file per call
- bash {command, timeout?} — shell exec, use for ls/find/grep/cat/head/verify/git, truncated 50KB
- custom tools: any pi.registerTool {name, parameters} — call by name with matching params object (discover via recall/skill list)
`;

export function registerInjection(pi: ExtensionAPI) {
  pi.on("before_agent_start" as any, async (ev: any, _ctx: any) => {
    brain.thinkSatisfied = false;
    brain.hasRecall = false;
    brain.hasWriteEdit = false;
    brain.hasRemember = false;
    brain.rule5Warned = false;
    // no prune, no budgetTrim — clean: no hidden side-effects

    if (brain.brainStrict) {
      const query: string = ev?.prompt ?? "";
      const recentThinkStrict = brain.deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}`).join("\n");
      const thinkBlockStrict = recentThinkStrict ? `\n\nRecent deliberation:\n${recentThinkStrict}` : "";
      const plan = latestPlan();
      const planBlock = plan ? `\n\nActive plan:\n${renderPlan(plan)}\n(id: ${plan.id})` : "";
      // clean: explicit recall nudge, NOT episodes — user must call recall tool to see episodes
      const recallNudge = query.trim()
        ? `Recall required: call recall{query: "${query.slice(0, 120).replace(/"/g, "'")}"} first.`
        : `Recall required: call recall{query: "<your task cue>"} first if you need prior episodes.`;
      const delta = `${recallNudge}${thinkBlockStrict}${planBlock}`;
      return { systemPrompt: STRICT_STABLE_PREFIX, message: { role: "system", content: delta } } as any;
    }
    // default mode: only deliberation + plan — no episode injection (clean)
    const planDef = latestPlan();
    const recentThink = brain.deliberations.slice(-1);
    if (!recentThink.length && !planDef) return;
    const parts: string[] = [];
    if (recentThink.length) parts.push(`Recent deliberations:\n${recentThink.map((d: any) => `- ${d.goal}: ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n")}`);
    if (planDef) parts.push(`Active plan:\n${renderPlan(planDef)}\n(id: ${planDef.id})`);
    return { message: { role: "system", content: parts.join("\n\n") } } as any;
  });

  pi.on("context" as any, async (ev: any) => {
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    // clean dedup only for injected brain blocks — no slicing, no hidden trimming
    const seen = new Set<string>();
    let changed = false;
    const deduped = msgs.filter((m: any) => {
      if (m.role !== "system") return true;
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (c.includes("Recent deliberations:") || c.includes("Active plan:") || c.includes("Recall required:")) {
        if (seen.has(c)) { changed = true; return false; }
        seen.add(c);
      }
      return true;
    });
    if (changed) {
      brain.stats.dedup++;
      (pi as any).events?.emit?.("brain:context-dedup", { deduped: true, before: msgs.length, after: deduped.length });
      return { messages: deduped } as any;
    }
  });
}
