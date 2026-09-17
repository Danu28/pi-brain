import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain, latestPlan, renderPlan } from "./state";

// Clean inject — no hidden auto-recall, no budgetTrim, no episode injection.
// User sees exactly what happens: recall must be called explicitly, episodes never appear without recall tool.
// Only stable prefix + explicit recall nudge + deliberation + plan are injected.

const STRICT_STABLE_PREFIX = `[STRICT BRAIN MODE ON — 7 RULES ENFORCED]
Happy (2-call floor): recall (top-3) → think (smart reads) → [creative-thinking if novel] → plan #1 → Turn1 read×N parallel → Turn2 edit×N+write×N+bash verify parallel → plan #2 done:[all] → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')
Unhappy: same happy path but during batch execution 2 continuous write/edit/bash failures → think{goal:"debug <issue>", hypotheses:[cause,fix]} → continue execution → plan done → remember → habit → git commit. Strict blocks write/edit/bash until debug think done; guided nudges. No looping — think WHY it fails instead of retrying same error.
Batch: 1 LLM call = N tool calls. Turn1: read×N parallel; Turn2: edit×N+write×N+bash parallel. Chunk edits: 1 edit per file, exact oldText, merge nearby changes. If oldText known → skip reads → 1 call. Record → 0-call replay. Prefer plan{hypotheses} single-shot (think+plan 2→1). 5-Step: Question→Delete→Simplify→Accelerate→Automate.

1. Recall-optional: call recall{query} ONCE at task start IF you need prior episodes — NEVER blocked if skipped. Do not re-recall during execution.
2. Think + Plan MANDATORY: think MUST smart-read required relevant files first, then call think{goal,hypotheses}, then plan{goal,tasks} — write/edit blocked until BOTH done (no broad reading, only relevant files).
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

const GUIDED_STABLE_PREFIX = `[GUIDED BRAIN MODE ON — FLOW GUIDE (NO HARD BLOCKS EXCEPT SAFETY)]
Happy: recall → think (smart reads) → [creative-thinking if novel] → plan → Turn1 read×N parallel → Turn2 edit×N+write×N+bash verify parallel → plan done → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')
Unhappy: recall → think → [creative-thinking if novel] → plan → batch execution (if 2 continuous failures) → think{goal:"debug <issue>", hypotheses:[cause,fix]} → continue → plan done → remember → habit → commit.
Note: 2 continuous write/edit/bash failures only trigger think (guided = nudge, not block). Safety rm -rf still blocks.
Guide (not enforced):
1. Recall-optional: call recall{query} ONCE at task start IF you need prior episodes — never blocked if skipped. Do not re-recall during execution.
2. Think + Plan before act: think{goal,hypotheses} → plan{goal,tasks} (smart reads first) — guided nudge only
3. creative-thinking only for novel tasks, skip for CRUD
4. plan after inputs, batch execution as above
5. shortest-diff + batch as above
6. encode after write/edit — remember nudge
7. git when plan done + remember
`;

const FOLLOWUP_RE = /^(yes|yeah|yep|y|ok|okay|k|go|continue|keep going|proceed|next|done|thanks|thank you|thx|ty|lgtm|sounds good|ship it|same|again|retry|stop|no|n|that'?s it|thats it|\.{3})$/i;
export function isFollowUpPrompt(prompt: string): boolean {
  const p = (prompt || "").trim();
  if (!p) return true;
  if (p.length <= 4) return true;
  if (FOLLOWUP_RE.test(p)) return true;
  return false;
}

export function registerInjection(pi: ExtensionAPI) {
  pi.on("before_agent_start" as any, async (ev: any, _ctx: any) => {
    const followUp = isFollowUpPrompt(ev?.prompt ?? "");
    // flags reset only on a NEW task (substantive prompt). Follow-up turns (continue/go/yes)
    // keep hasRecall/thinkSatisfied sticky so no forced re-recall / re-think mid-task.
    if (!followUp) {
      brain.thinkSatisfied = false;
      brain.hasRecall = false;
      brain.hasWriteEdit = false;
      brain.hasRemember = false;
      brain.rule5Warned = false;
      (brain as any).hasPlan = false;
    }
    // failureCount persists across turns for 2-continuous detection — do not reset here
    // no prune, no budgetTrim — clean: no hidden side-effects

    const mode = (brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off");
    if (mode === "strict") {
      const query: string = ev?.prompt ?? "";
      const recentThinkStrict = brain.deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}`).join("\n");
      const thinkBlockStrict = recentThinkStrict ? `\n\nRecent deliberation:\n${recentThinkStrict}` : "";
      const plan = latestPlan();
      const planBlock = plan ? `\n\nActive plan:\n${renderPlan(plan)}\n(id: ${plan.id})` : "";
      // 1 recall per task: nudge only for new substantive tasks; on follow-up turns use plan/think context only
      const recallNudge = !followUp
        ? `Recall first: call recall{query: "${query.slice(0, 120).replace(/"/g, "'")}"} ONCE (first tool call). Do not call recall again during execution.`
        : "";
      const delta = `${recallNudge}${thinkBlockStrict}${planBlock}`;
      return { systemPrompt: STRICT_STABLE_PREFIX, message: { role: "system", content: delta } } as any;
    }
    if (mode === "guided") {
      const query: string = ev?.prompt ?? "";
      const recentThinkGuided = brain.deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}`).join("\n");
      const thinkBlockGuided = recentThinkGuided ? `\n\nRecent deliberation:\n${recentThinkGuided}` : "";
      const plan = latestPlan();
      const planBlock = plan ? `\n\nActive plan:\n${renderPlan(plan)}\n(id: ${plan.id})` : "";
      const recallNudge = !followUp
        ? `Guided: consider recall{query: "${query.slice(0, 120).replace(/"/g, "'")}"} ONCE at task start if you need prior episodes. Do not call recall again during execution.`
        : "";
      const delta = `${recallNudge}${thinkBlockGuided}${planBlock}`;
      return { systemPrompt: GUIDED_STABLE_PREFIX, message: { role: "system", content: delta } } as any;
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
