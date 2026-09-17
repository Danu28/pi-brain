import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "./scoring";
import { brain, isPlanDone, isVerbose } from "./state";

// Clean hooks — no hidden auto-encode, no noise filter, no touch.
// Every persistence is explicit via remember. Hooks only set flags, guard, and nudge.

export function registerHooks(pi: ExtensionAPI) {
  // Preflight-aware gate: pi preflights ALL sibling tool calls of one assistant
  // message BEFORE any executes (docs/extensions.md :: tool_call). A model that
  // batches think→plan→edit in ONE message would otherwise get its edits blocked
  // because thinkSatisfied/hasPlan don't flip until execute() runs. Scan the last
  // assistant message for pending sibling calls and count them as satisfying the gate.
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
        break; // only the current assistant tool-calling message
      }
    } catch {}
    return names;
  };
  // Terse duplicate-block hint: siblings blocked by the same rule in the same
  // preflight batch (within 2s) get a 1-line reason — the first one carries the explanation.
  let lastBlockHint: { rule: string; ts: number } | null = null;
  const blockHint = (rule: string, long: string, short: string): string => {
    const now = Date.now();
    const dupe = !!lastBlockHint && lastBlockHint.rule === rule && now - lastBlockHint.ts < 2000;
    lastBlockHint = { rule, ts: now };
    return dupe ? short : long;
  };

  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    // clean: edit/write/bash success only sets flags — NO auto episode creation
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      brain.hasWriteEdit = true;
      brain.hasRemember = false;
    } else if (ev?.toolName === "bash" && !ev?.isError) {
      // bash is a verification step — do not auto-encode; agent must explicit remember if worth persisting
      // optional: mark hasWriteEdit if you want bash to require remember — keep separate
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
    // success resets consecutive failure count
    if (!ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      (brain as any).failureCount = 0;
      if (brain.needsDebugThink) { brain.needsDebugThink = false; (brain as any).failureCount = 0; }
    }
    // think debug success clears failure count
    if (!ev?.isError && ev?.toolName === "think" && (ev as any)?.details?.deliberation?.goal?.toLowerCase?.().startsWith("debug")) {
      (brain as any).failureCount = 0;
      brain.needsDebugThink = false;
      brain.needsPlanUpdate = false;
    }
    // unhappy path: 2 continuous failures trigger think (both strict and guided)
    if (ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      (brain as any).failureCount = (((brain as any).failureCount ?? 0) + 1);
      const cnt = (brain as any).failureCount;
      const mode = (brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off");
      if (cnt >= 2) {
        brain.needsDebugThink = true;
        brain.needsPlanUpdate = false;
        brain.thinkSatisfied = false;
        const msg = mode === "strict"
          ? "Strict unhappy: 2 continuous failures — BLOCKED until think{goal:'debug <task>', hypotheses:[cause,fix]}"
          : mode === "guided"
          ? "Guided unhappy: 2 continuous failures — please call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry (nudge)"
          : "2 continuous failures — call think{goal:'debug <task>', hypotheses:[cause,fix]}";
        try { (ctx as any)?.ui?.notify?.(msg, "warning"); } catch {}
        (pi as any).events?.emit?.(mode === "strict" ? "brain:block" : "brain:nudge", { tool: ev?.toolName, rule: "needsDebugThink", reason: `2 continuous failures (${cnt})`, mode });
        if (mode === "strict") (brain as any).stats.block++;
        else (brain as any).stats.nudge++;
        const hint = mode === "strict"
          ? "\n[ brain: 2 continuous failures → BLOCKED until think{goal:'debug <task>', hypotheses:[cause,fix]} ]"
          : "\n[ brain: 2 continuous failures → please call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry (guided nudge) ]";
        const cur = ev.content?.[0]?.text ?? "";
        return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
      } else {
        // pre-threshold failures: keep the in-result hint (model sees it), skip the toast
        // (chatty) unless PI_BRAIN_VERBOSE — the 2nd failure notifies via the branch above
        if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`Failure ${cnt}/2 — 1 more continuous failure will trigger debug think`, "warning"); } catch {}
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: "failureCount", count: cnt });
        (brain as any).stats.nudge++;
        const hint = `\n[ brain: failure ${cnt}/2 — 2 continuous failures trigger think{debug} ]`;
        const cur = ev.content?.[0]?.text ?? "";
        return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
      }
    }
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    // rm -rf guard (kept — safety, not hidden business logic)
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
    const mode = (brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off");
    // unhappy: 2 continuous failures → strict BLOCK, guided NUDGE
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
        // guided: nudge only, do not block
      }
    }
    // Strict: Think + Plan MANDATORY — recall OPTIONAL (never blocked if missed).
    // Gate fires EARLIEST (plan is the first pre-edit tool) and is batch-aware:
    // a pending think/plan call in the SAME assistant message counts as satisfied
    // (preflight runs before any sibling executes, so flags flip mid-batch).
    if (ev?.toolName === "write" || ev?.toolName === "edit" || ev?.toolName === "plan") {
      const pending = pendingSiblingNames(ctx);
      if (mode === "strict") {
        const thinkOk = brain.thinkSatisfied || pending.has("think");
        if (ev?.toolName === "plan" && !thinkOk) {
          brain.stats.block++;
          (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 2, reason: "think before plan", mode });
          if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block plan Rule 2 think first`, "warning"); } catch {}
          return { block: true, reason: blockHint("r2", "Blocked by strict Rule 2: call think{goal,hypotheses} BEFORE plan — plan is gated on think. Think is MANDATORY.", "[brain:block Rule 2 — call think{goal,hypotheses} first, then plan]") } as any;
        }
        if (ev?.toolName === "write" || ev?.toolName === "edit") {
          if (!thinkOk) {
            brain.stats.block++;
            (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 2, reason: "think before act", mode });
            if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 2 think first`, "warning"); } catch {}
            return { block: true, reason: blockHint("r2", "Blocked by strict Rule 2: call think{goal,hypotheses} before write/edit. Think is MANDATORY — re-issue the batch after think + plan succeed.", "[brain:block Rule 2 — call think{goal,hypotheses} first, then re-issue edits]") } as any;
          }
          const planOk = (brain as any).hasPlan || (pending.has("think") && pending.has("plan"));
          if (!planOk) {
            brain.stats.block++;
            (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 4, reason: "plan after think", mode });
            if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 4 plan first`, "warning"); } catch {}
            return { block: true, reason: blockHint("r4", "Blocked by strict Rule 4: call plan{goal,tasks} AFTER think before write/edit. Think + Plan are MANDATORY.", "[brain:block Rule 4 — call plan{goal,tasks} first, then re-issue edits]") } as any;
          }
        }
      } else if (mode === "guided") {
        if (!brain.thinkSatisfied) {
          brain.stats.nudge++;
          (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: 2, reason: "think recommended", mode });
          try { (ctx as any)?.ui?.notify?.("Guided nudge: consider think{goal,hypotheses} before plan/write/edit", "warning"); } catch {}
        } else if (!(brain as any).hasPlan && (ev?.toolName === "write" || ev?.toolName === "edit")) {
          brain.stats.nudge++;
          (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: 4, reason: "plan recommended", mode });
          try { (ctx as any)?.ui?.notify?.("Guided nudge: consider plan{goal,tasks} after think before write/edit", "warning"); } catch {}
        }
      }
    }
  });

  // Rule 5: encode-or-it-didn't-happen — nudge in both strict and guided (off disabled)
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    const mode = (brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off");
    if (mode === "off") return;
    const prefix = mode === "strict" ? "Strict" : "Guided";
    if (brain.hasWriteEdit && !brain.hasRemember && !brain.rule5Warned && isPlanDone()) {
      brain.rule5Warned = true;
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, reason: "hasWriteEdit without remember after plan done", mode });
      try { ctx?.ui?.notify?.(`${prefix} Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).`, "warning"); } catch {}
    } else if (brain.hasWriteEdit && !brain.hasRemember && brain.rule5Warned && isPlanDone()) {
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, pending: true, mode });
      if (isVerbose()) try { ctx?.ui?.notify?.("brain:nudge Rule 5 still pending — call remember", "warning"); } catch {}
    }
  });
}
