import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "./scoring";
import { brain, isPlanDone, isVerbose } from "./state";

// Clean hooks — no hidden auto-encode, no noise filter, no touch.
// Every persistence is explicit via remember. Hooks only set flags, guard, and nudge.

export function registerHooks(pi: ExtensionAPI) {
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
        try { (ctx as any)?.ui?.notify?.(`Failure ${cnt}/2 — 1 more continuous failure will trigger debug think`, "warning"); } catch {}
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
        return { block: true, reason: "Blocked by strict: 2 continuous failures — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retry." } as any;
      } else if (mode === "guided") {
        brain.stats.nudge++;
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: "needsDebugThink", reason: "2 continuous failures — think recommended", mode });
        try { (ctx as any)?.ui?.notify?.("Guided nudge: 2 continuous failures — please call think{goal:'debug ...'} before retry", "warning"); } catch {}
        // guided: nudge only, do not block
      }
    }
    // Rule 1 recall-first: strict BLOCK, guided NUDGE
    if (!brain.hasRecall && ["write", "edit"].includes(ev?.toolName)) {
      if (mode === "strict") {
        brain.stats.block++;
        (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 1, reason: "recall first", mode });
        if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 1 recall first — call recall{query} before write/edit`, "warning"); } catch {}
        return { block: true, reason: "Blocked by strict Rule 1: call recall{query} first to check prior episodes (explicit, no auto-injection)." } as any;
      } else if (mode === "guided") {
        brain.stats.nudge++;
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: 1, reason: "recall recommended", mode });
        try { (ctx as any)?.ui?.notify?.("Guided nudge: consider recall{query} first to check prior episodes", "warning"); } catch {}
      }
    }
    // Rule 2 think-before-act: strict BLOCK, guided NUDGE
    if ((ev?.toolName === "write" || ev?.toolName === "edit") && !brain.thinkSatisfied) {
      if (mode === "strict") {
        brain.stats.block++;
        (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 2, reason: "think before act", mode });
        if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 2 think first`, "warning"); } catch {}
        return { block: true, reason: "Blocked by strict Rule 2: call think{goal,hypotheses} before write/edit. Deliberate 2-3 approaches first." } as any;
      } else if (mode === "guided") {
        brain.stats.nudge++;
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: 2, reason: "think recommended", mode });
        try { (ctx as any)?.ui?.notify?.("Guided nudge: consider think{goal,hypotheses} before write/edit", "warning"); } catch {}
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
