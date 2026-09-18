import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "./knobs";
import { brain, getBrainMode, isPlanDone, isVerbose } from "./state";

function isQuiet(): boolean { return process.env.PI_BRAIN_QUIET === "1"; }
let lastNudgeTs = 0;
function shouldNudge(): boolean {
  if (isQuiet()) return false;
  const now = Date.now();
  if (now - lastNudgeTs < 1000) return false;
  lastNudgeTs = now;
  return true;
}
function isTrivialEdit(ev: any): boolean {
  try {
    const inp = ev?.input ?? {};
    const file = inp.file ?? inp.path ?? "";
    if (!file) return false;
    const diffLen = (inp.oldText ?? inp.content ?? "").toString().split("\n").length;
    const size = String(inp.oldText ?? inp.newText ?? inp.content ?? "").length;
    const risk = inp.risk !== undefined ? Number(inp.risk) : 999;
    if (risk !== 999 && risk > 3) return false;
    if (diffLen > 30 || size > 800) return false;
    return true;
  } catch { return false; }
}
// S01 tiered router: 1=trivial (<30 lines, risk≤3, 1 file), 2=feature (<300 lines), 3=complex
export function taskTier(prompt: string, diffStat?: { lines:number; files:number; risk?:number }): 1|2|3 {
  try {
    const { TIER1_LINES, TIER1_RISK, TIER2_LINES } = require("./knobs");
    const lines = diffStat?.lines ?? prompt.length / 40;
    const files = diffStat?.files ?? 1;
    const risk = diffStat?.risk ?? 5;
    if (lines < TIER1_LINES && risk <= TIER1_RISK && files === 1) return 1;
    if (lines < TIER2_LINES) return 2;
    return 3;
  } catch { return 2; }
}
function recallSkippable(ctx: any): boolean {
  try {
    // S02: if compaction gist already hot (lastCompactionKept has recent high-score hits), skip recall call
    const { brain } = require("./state");
    const kept = brain.lastCompactionSummary || "";
    if (kept.includes("Brain episodes:") && brain.episodes.size) return true;
    return false;
  } catch { return false; }
}

export function registerHooks(pi: ExtensionAPI) {
  const pendingSiblingNames = (ctx: any): Set<string> => {
    const names = new Set<string>();
    try {
      const branch: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e?.type !== "message") continue;
        const m = e?.message;
        if (m?.role !== "assistant") continue;
        const content = Array.isArray(m.content) ? m.content : [];
        for (const c of content) {
          if (c && typeof c === "object" && (c.type === "toolCall" || c.type === "tool_call") && typeof (c as any).name === "string") names.add((c as any).name);
        }
        for (const k of ["toolCalls", "tool_calls"]) {
          const tc = m[k];
          if (Array.isArray(tc)) for (const c of tc) { if (c && typeof c.name === "string") names.add(c.name); }
        }
        break;
      }
    } catch {}
    return names;
  };
  let lastBlockHint: { rule: string; ts: number } | null = null;
  const blockHint = (rule: string, long: string, short: string): string => {
    const now = Date.now();
    const dupe = !!lastBlockHint && lastBlockHint.rule === rule && now - lastBlockHint.ts < 2000;
    lastBlockHint = { rule, ts: now };
    return dupe ? short : long;
  };

  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      brain.hasWriteEdit = true;
      brain.hasRemember = false;
    }
    if (ev?.toolName === "recall" && !ev?.isError) {
      brain.hasRecall = true;
      (pi as any).events?.emit?.("brain:recall", { query: (ev.input?.query ?? ev.input?.queries ?? "").toString().slice(0, 120) });
    }
    if ((ev?.toolName === "remember" || ev?.toolName === "habit") && !ev?.isError) {
      const blocked = (ev as any)?.details?.blocked === true || (ev as any)?.result?.blocked === true;
      if (!blocked) {
        brain.hasRemember = true;
        brain.hasWriteEdit = false;
        brain.rule5Warned = false;
      }
    }
    if (!ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      brain.failureCount = 0;
      if (brain.needsDebugThink) { brain.needsDebugThink = false; brain.failureCount = 0; }
    }
    if (!ev?.isError && ev?.toolName === "think" && (ev as any)?.details?.deliberation?.goal?.toLowerCase?.().startsWith("debug")) {
      brain.failureCount = 0;
      brain.needsDebugThink = false;
    }
    if (ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      brain.failureCount = ((brain.failureCount ?? 0) + 1);
      const cnt = brain.failureCount;
      const mode = getBrainMode();
      if (cnt >= 2) {
        brain.needsDebugThink = true;
        brain.thinkSatisfied = false;
        const msg = mode === "strict"
          ? "Strict unhappy: 2 continuous failures — BLOCKED until think{goal:'debug <task>', hypotheses:[cause,fix]}"
          : mode === "guided"
          ? "Guided unhappy: 2 continuous failures — please call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry (nudge)"
          : "2 continuous failures — call think{goal:'debug <task>', hypotheses:[cause,fix]}";
        try { (ctx as any)?.ui?.notify?.(msg, "warning"); } catch {}
        (pi as any).events?.emit?.(mode === "strict" ? "brain:block" : "brain:nudge", { tool: ev?.toolName, rule: "needsDebugThink", reason: `2 continuous failures (${cnt})`, mode });
        if (mode === "strict") brain.stats.block++;
        else brain.stats.nudge++;
        const hint = mode === "strict"
          ? "\n[ brain: 2 continuous failures → BLOCKED until think{goal:'debug <task>', hypotheses:[cause,fix]} ]"
          : "\n[ brain: 2 continuous failures → please call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry (guided nudge) ]";
        const cur = ev.content?.[0]?.text ?? "";
        return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
      } else {
        if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`Failure ${cnt}/2 — 1 more continuous failure will trigger debug think`, "warning"); } catch {}
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: "failureCount", count: cnt });
        brain.stats.nudge++;
        const hint = `\n[ brain: failure ${cnt}/2 — 2 continuous failures trigger think{debug} ]`;
        const cur = ev.content?.[0]?.text ?? "";
        return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
      }
    }
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    if (ev?.toolName === "bash") {
      const cmd: string = ev?.input?.command ?? "";
      const low = cmd.toLowerCase();
      const isRmRf = /\brm\b/.test(low) && (/\s-[a-z]*r[a-z]*f/.test(low) || (low.includes("--recursive") && low.includes("--force")));
      if (isRmRf) {
        if (!ctx?.hasUI) return { block: true, reason: "Blocked by brain guard: rm -rf needs UI confirm" } as any;
        try {
          const ok = await ctx.ui.confirm("Dangerous", "Allow rm -rf?");
          if (!ok) return { block: true, reason: "Blocked by brain guard" } as any;
        } catch {
          return { block: true, reason: "Blocked by brain guard" } as any;
        }
      }
    }
    const mode = getBrainMode();
    if (brain.needsDebugThink && ["write", "edit", "bash"].includes(ev?.toolName)) {
      if (mode === "strict") {
        brain.stats.block++;
        (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: "needsDebugThink", reason: "2 continuous failures require debug think", mode });
        if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} needsDebugThink (strict)`, "warning"); } catch {}
        return { block: true, reason: blockHint("needsDebugThink", "Blocked by strict: 2 continuous failures — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retry.", "[brain:block needsDebugThink — call think{goal:'debug <task>', hypotheses:[cause, fix]} before retry]") } as any;
      } else if (mode === "guided") {
        brain.stats.nudge++;
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: "needsDebugThink", reason: "2 continuous failures — think recommended", mode });
        try { (ctx as any)?.ui?.notify?.("Guided nudge: 2 continuous failures — please call think{goal:'debug ...'} before retry", "warning"); } catch {}
      }
    }
    if (ev?.toolName === "write" || ev?.toolName === "edit" || ev?.toolName === "plan") {
      const pending = pendingSiblingNames(ctx);
      if (mode === "strict") {
        // S01+S04 tiered router + trivial escape: tier-1 skips think+plan when quality gate passes
        const trivial = (ev?.toolName === "write" || ev?.toolName === "edit") && isTrivialEdit(ev);
        const tier = (ev?.toolName === "write" || ev?.toolName === "edit") ? taskTier(ev?.input?.file ?? "", { lines: String(ev?.input?.oldText ?? ev?.input?.content ?? "").split("\n").length, files:1, risk: ev?.input?.risk }) : 3;
        const qualityGate = (()=> { try { const { relevanceForRemember } = require("./scoring"); const r = relevanceForRemember(ev?.input?.file ?? "task", ev?.input?.oldText ?? "edit", undefined, undefined, undefined); return r.score >=4; } catch { return false; }})();
        if (trivial && (tier===1 || qualityGate)) {
          (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: "tier1-skip", reason: `tier ${tier} skip: trivial edit bypassed strict gate (qualityGate=${qualityGate})`, mode, trivial: true, tier });
          // allow — do not block (S01+S07)
        } else if (ev?.toolName === "recall" && recallSkippable(ctx)) {
          // S02: hint to skip recall when gist hot — nudge not block
          (pi as any).events?.emit?.("brain:skip", { tool: "recall", reason: "gist hot — recall skippable via context inject", tier });
          // still allow recall if caller insists
        } else {
        const thinkOk = brain.thinkSatisfied || pending.has("think");
        if (ev?.toolName === "plan" && !thinkOk) {
          brain.stats.block++;
          (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 2, reason: "think before plan", mode });
          if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block plan Rule 2 think first`, "warning"); } catch {}
          return { block: true, reason: blockHint("r2", "Blocked by strict Rule 2: call think{goal,hypotheses} BEFORE plan — plan is gated on think. Think is MANDATORY.\n→ fix: think{goal:\"add auth\", hypotheses:[\"Side A | cost:4 risk:3 rev:8 | JWT\", \"Side B | cost:6 risk:5 rev:6 | session\"]}", "[brain:block Rule 2 — call think{goal,hypotheses} first, then plan]") } as any;
        }
        if (ev?.toolName === "write" || ev?.toolName === "edit") {
          if (!thinkOk) {
            brain.stats.block++;
            (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 2, reason: "think before act", mode });
            if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 2 think first`, "warning"); } catch {}
            return { block: true, reason: blockHint("r2", "Blocked by strict Rule 2: call think{goal,hypotheses} before write/edit. Think is MANDATORY — re-issue the batch after think + plan succeed.\n→ fix: think{goal:\"add auth\", hypotheses:[\"A | cost:4 risk:3 rev:8 | JWT\", \"B | cost:6 risk:5 rev:6 | session\"]}", "[brain:block Rule 2 — call think{goal,hypotheses} first, then re-issue edits]") } as any;
          }
          const planOk = brain.hasPlan || (pending.has("think") && pending.has("plan"));
          if (!planOk) {
            brain.stats.block++;
            (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 4, reason: "plan after think", mode });
            if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 4 plan first`, "warning"); } catch {}
            return { block: true, reason: blockHint("r4", "Blocked by strict Rule 4: call plan{goal,tasks} AFTER think before write/edit. Think + Plan are MANDATORY.\n→ fix: plan{goal:\"implement auth\", tasks:[\"auth routes\",\"token schema\",\"login endpoint\",\"tests\"]}", "[brain:block Rule 4 — call plan{goal,tasks} first, then re-issue edits]") } as any;
          }
        }
        }
      } else if (mode === "guided") {
        // S18 debounced nudges: 1 per turn max + PI_BRAIN_QUIET silences UI nudges
        if (!brain.thinkSatisfied) {
          brain.stats.nudge++;
          (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: 2, reason: "think recommended", mode });
          if (shouldNudge()) try { (ctx as any)?.ui?.notify?.("Guided nudge: consider think{goal,hypotheses} before plan/write/edit", "warning"); } catch {}
        } else if (!brain.hasPlan && (ev?.toolName === "write" || ev?.toolName === "edit")) {
          brain.stats.nudge++;
          (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: 4, reason: "plan recommended", mode });
          if (shouldNudge()) try { (ctx as any)?.ui?.notify?.("Guided nudge: consider plan{goal,tasks} after think before write/edit", "warning"); } catch {}
        }
      }
    }
  });

  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    const mode = getBrainMode();
    if (mode === "off") return;
    // flush debounced sidecar on turn_end if plan done (S21)
    try { const { flushMemory, isPlanDone: _isDone } = await import("./state"); if (_isDone()) await flushMemory();
    // gated auto-commit nudge (S16) — after plan done + dirty git + opt-in tests pass
    if (_isDone() && !isQuiet()) {
      try {
        const { execSync } = await import("node:child_process");
        const dirty = (()=> { try { execSync("git diff --quiet", { stdio:"ignore"}); return false; } catch { return true; }})();
        if (dirty) {
          (pi as any).events?.emit?.("brain:commit-ready", { goal: brain.cachedLatestPlan?.goal ?? "" });
          if (shouldNudge()) try { ctx?.ui?.notify?.(`Commit ready: bash: git add -A && git commit -m 'feat: ${brain.cachedLatestPlan?.goal?.slice(0,40)??"update"}'`, "info"); } catch {}
        }
      } catch {}
    }
    } catch {}
    const prefix = mode === "strict" ? "Strict" : "Guided";
    if (brain.hasWriteEdit && !brain.hasRemember && !brain.rule5Warned && isPlanDone()) {
      brain.rule5Warned = true;
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, reason: "hasWriteEdit without remember after plan done", mode });
      if (!isQuiet() && shouldNudge()) try { ctx?.ui?.notify?.(`${prefix} Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).`, "warning"); } catch {}
    } else if (brain.hasWriteEdit && !brain.hasRemember && brain.rule5Warned && isPlanDone()) {
      if (isVerbose() && !isQuiet() && shouldNudge()) { brain.stats.nudge++; (pi as any).events?.emit?.("brain:nudge", { rule: 5, pending: true, mode }); try { ctx?.ui?.notify?.("brain:nudge Rule 5 still pending — call remember", "warning"); } catch {} }
    }
  });
}
