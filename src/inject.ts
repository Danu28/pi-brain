import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUDGET_STOP_PCT, BUDGET_WARN_PCT, PRUNE_WARN } from "./knobs";
import { compressEpisodes, pruneExpired, scoreEpisode } from "./scoring";
import { brain, latestPlan, renderPlan } from "./state";
import type { BrainEpisode } from "./types";

// T6 stable prefix for KV-cache — literal only, never interpolate; delta goes in message
const STRICT_STABLE_PREFIX = `[STRICT BRAIN MODE ON — 7 RULES ENFORCED]\nHappy (2-call floor): recall (top-3) → think (smart reads) → [creative-thinking if novel] → plan #1 → Turn1 read×N parallel → Turn2 edit×N+write×N+bash verify parallel → plan #2 done:[all] → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')\nUnhappy (3-call floor): same but 3 plan calls — plan #1 → failure → think{goal:"debug <failed Task N>", hypotheses:[root cause, fix]} → plan #2 → retry Turn1/Turn2 → plan #3 done:[all] → remember → habit → git commit. Execution blocked until debug-think done.\nBatch: 1 LLM call = N tool calls. Turn1: read×N parallel; Turn2: edit×N+write×N+bash parallel. Chunk edits: 1 edit per file, exact oldText, merge nearby changes. If oldText known → skip reads → 1 call. Record → 0-call replay. Prefer plan{hypotheses} single-shot (think+plan 2→1). 5-Step: Question→Delete→Simplify→Accelerate→Automate.\n\n1. Recall-first: picks top-3 relevant (TF-IDF 2x/1x/0.5x + tag boost 1.5 + decay 0.5/7d). If recall empty/no relevant → scan current dir: bash ls + read relevant files smart (only relevant) to find context (don't read a lot). Cite cue(s) when episodes exist.\n2. Think-before-act: think MUST smart-read required relevant files first, then call think{goal,hypotheses} — ensure all info needed to finish task is gathered BEFORE plan (enforced — write will be blocked otherwise; no broad reading, only relevant files).\n3. Creative-thinking-only-for-novelty: call creative-thinking when task is creative/novel (e.g. "creative login", "novel approach"), SKIP for CRUD/bugfix — do this BEFORE planning to get all inputs.\n4. Plan-after-inputs: after think (+ creative-thinking if novel) → plan #1 creates [ ] checklist; final update is plan #2 done:[0,1,...] batch all (no incremental). Unhappy: plan #2 after debug think, plan #3 final batch. Execution is batched: Turn1 read×N, Turn2 edit×N+write×N+bash.\n5. Shortest-diff + Batch: Turn1 read×N parallel → Turn2 edit×N+write×N+bash parallel, 1 edit per file with exact oldText, no scaffolding for later. Bash verify after edits land (not same call as edit it checks).\n6. Encode: after every successful write/edit/bash you MUST call remember{cue,summary}; 2nd repeat of same fix → habit{name,when,steps}.\n7. Git: when plan 2/2 done + remember done, bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>' (skip if no changes).\n\nPi Tools — use exactly as defined:\n- read {path, offset?, limit?} — read text/image, truncated 50KB/2000 lines; large files via offset/limit\n- write {path, content} — create/overwrite, auto-creates parent dirs\n- edit {path, edits:[{oldText,newText}]} — exact unique oldText, non-overlapping, merge nearby changes, one file per call\n- bash {command, timeout?} — shell exec, use for ls/find/grep/cat/head/verify/git, truncated 50KB\n- custom tools: any pi.registerTool {name, parameters} — call by name with matching params object (discover via recall/skill list)\n`;

export function registerInjection(pi: ExtensionAPI) {
  // strict workflow run lifecycle — reset per prompt (unconditional reset, no timestamp drift)
  pi.on("before_agent_start" as any, async (ev: any, ctx: any) => {
    brain.thinkSatisfied = false;
    brain.hasWriteEdit = false;
    brain.hasRemember = false;
    brain.rule5Warned = false;
    // per-agent reset only on session_start/failure, not every prompt — persist needsDebugThink/needsPlanUpdate
    // T10 budget: try provider usage if available
    let pct: number | undefined;
    try { const u = (ctx as any)?.getContextUsage?.() ?? (ev as any)?.getContextUsage?.(); if (u?.percent) pct = u.percent; else if (u?.used && u?.total) pct = Math.round(u.used/u.total*100); } catch {}
    // T2 periodic prune if many
    if (brain.episodes.size > PRUNE_WARN) pruneExpired(pi);
    // strict mode: scored recall + stable prefix (T6) + gist (T3) + budget (T10)
    if (brain.brainStrict) {
      const query: string = ev?.prompt ?? "";
      const all = [...brain.episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now());
      const scored = all
        .map((e) => ({ e, s: scoreEpisode(e, query) }))
        .filter((x) => x.s > 0 || query.trim() === "")
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, 3)
        .map((x) => x.e);
      const ranked = scored.length ? scored : all.sort((a, b) => b.ts - a.ts).slice(0, 3);
      // T10 budget guard: shrink delta if overloaded
      let deltaRanked = ranked;
      if (pct !== undefined) {
        if (pct > BUDGET_STOP_PCT) deltaRanked = [];
        else if (pct > BUDGET_WARN_PCT) deltaRanked = ranked.slice(0,1);
      }
      const context = deltaRanked.length
        ? compressEpisodes(deltaRanked)
        : "(no relevant episodes — scan current dir: bash ls + read relevant files smart (only relevant) to find context)";
      const recentThinkStrict = brain.deliberations.slice(-1).map((d:any)=>`[think: ${d.goal}] ${d.hypotheses.join("; ")}`).join("\n");
      const thinkBlockStrict = recentThinkStrict ? `\n\nRecent deliberation:\n${recentThinkStrict}` : "";
      // T6: stable systemPrompt + variable delta as separate system message (KV-cache friendly)
      const plan = latestPlan();
      const planBlock = plan ? `\n\nActive plan:\n${renderPlan(plan)}\n(id: ${plan.id})` : "";
      const delta = `Brain episodes for query "${query.slice(0, 120)}":\n${context}${thinkBlockStrict}${planBlock}`;
      // stable prefix cached, delta varies per turn but doesn't break prefix
      return { systemPrompt: STRICT_STABLE_PREFIX, message: { role: "system", content: delta } } as any;
    }
    // default mode: gated light injection — 1 episode gist + 1 deliberation (T3+T8) + budget
    const planDef = latestPlan();
    // pick scored top-1 for default (T8) not just recency
    let recent: BrainEpisode[] = [];
    if (brain.episodes.size) {
      const q = (ev?.prompt ?? "") as string;
      if (q.trim()) {
        const all = [...brain.episodes.values()].filter(e=> !e.expiresAt || e.expiresAt > Date.now());
        const scored = all.map(e=>({e,s:scoreEpisode(e,q)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts).slice(0,1).map(x=>x.e);
        recent = scored.length ? scored : [...brain.episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,1);
      } else {
        recent = [...brain.episodes.values()].sort((a, b) => b.ts - a.ts).slice(0, 1);
      }
    }
    // budget guard: if overloaded skip inject
    if (pct !== undefined && pct > BUDGET_STOP_PCT) recent = [];
    const recentThink = brain.deliberations.slice(-1);
    if (!recent.length && !recentThink.length && !planDef) return;
    const parts: string[] = [];
    if (recent.length) parts.push(`Recent brain episodes:\n${compressEpisodes(recent)}`);
    if (recentThink.length) parts.push(`Recent deliberations:\n${recentThink.map((d: any) => `- ${d.goal}: ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n")}`);
    if (planDef) parts.push(`Active plan:\n${renderPlan(planDef)}\n(id: ${planDef.id})`);
    // also respect budget warn: if warn, only 1 block
    if (pct !== undefined && pct > BUDGET_WARN_PCT && parts.length > 1) {
      return { message: { role: "system", content: parts[0] } } as any;
    }
    return { message: { role: "system", content: parts.join("\n\n") } } as any;
  });

  pi.on("context" as any, async (ev: any) => {
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    // dedup only — old sys.slice(0,1)+tail.slice(-20) orphaned tool_result from its
    // assistant tool_calls, causing OpenAI 400: No function call found for call_id 'call_...'
    // pi's compaction already handles window limits safely; don't slice here.
    const seen = new Set<string>();
    let changed = false;
    const deduped = msgs.filter((m: any) => {
      if (m.role !== "system") return true; // only system injections contain brain blocks; never touch tool pairs
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (c.includes("Recent brain episodes:") || c.includes("Brain episodes:")) {
        if (seen.has(c)) { changed = true; return false; }
        seen.add(c);
      }
      return true;
    });
    if (changed) return { messages: deduped } as any;
  });
}