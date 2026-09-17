import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncate } from "./scoring";
import { brain, getBrainMode, isPlanDone, isVerbose } from "./state";

// pi-brain lean — silent when it works, a tutor only when you fail twice, memory always.
// Hooks do exactly three things, nothing else:
//   1. tutor: count consecutive write/edit/bash failures → 2 in a row arms the tutor =
//      write/edit blocked until think{debug} (bash stays free for probing/verification)
//   2. safety: rm -rf needs UI confirm
//   3. memory: turn_end nudges `remember` once when edits landed and plan is done, no remember yet
// No happy-path ceremony: think/plan/creative-thinking are NEVER mandatory before write/edit.
// No hidden writes: every persistence is explicit via remember.

export function registerHooks(pi: ExtensionAPI) {
  // Terse duplicate-block hint: a tutor block hitting several tools in one batch is
  // explained once; siblings get a 1-line pointer.
  let lastBlockHint: { rule: string; ts: number } | null = null;
  const blockHint = (rule: string, long: string, short: string): string => {
    const now = Date.now();
    const dupe = !!lastBlockHint && lastBlockHint.rule === rule && now - lastBlockHint.ts < 2000;
    lastBlockHint = { rule, ts: now };
    return dupe ? short : long;
  };

  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    // clean: edit/write success only sets flags — NO auto episode creation
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
      if (blocked) {
        // audit-blocked (similar episode / preview) — the model DID attempt persistence;
        // the audit message already teaches force:true / habit. Don't re-nudge on turn_end.
        brain.hasRemember = true;
        brain.rule5Warned = true;
      } else {
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
    // debug think success clears the tutor block
    if (!ev?.isError && ev?.toolName === "think" && (ev as any)?.details?.deliberation?.goal?.toLowerCase?.().startsWith("debug")) {
      (brain as any).failureCount = 0;
      brain.needsDebugThink = false;
      brain.needsPlanUpdate = false;
    }
    // the tutor: 2 continuous write/edit/bash failures → think{debug} required before retry
    if (ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      (brain as any).failureCount = (((brain as any).failureCount ?? 0) + 1);
      const cnt = (brain as any).failureCount;
      if (cnt >= 2) {
        brain.needsDebugThink = true;
        brain.needsPlanUpdate = false;
        brain.thinkSatisfied = false;
        const msg = "2 continuous failures — call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry";
        try { (ctx as any)?.ui?.notify?.(msg, "warning"); } catch {}
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: "needsDebugThink", reason: `2 continuous failures (${cnt})` });
        brain.stats.nudge++;
        const hint = "\n[ brain: 2 continuous failures → think{goal:'debug <task>', hypotheses:[cause, fix]} before retry ]";
        const cur = ev.content?.[0]?.text ?? "";
        return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
      } else {
        try { (ctx as any)?.ui?.notify?.(`Failure ${cnt}/2 — 1 more continuous failure triggers the debug tutor`, "warning"); } catch {}
        (pi as any).events?.emit?.("brain:nudge", { tool: ev?.toolName, rule: "failureCount", count: cnt });
        brain.stats.nudge++;
        const hint = `\n[ brain: failure ${cnt}/2 — 2 continuous failures → think{debug} ]`;
        const cur = ev.content?.[0]?.text ?? "";
        return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
      }
    }
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    if (getBrainMode() !== "on") return; // off = stock pi behavior
    // safety guard (kept — not ceremony)
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
    // the tutor: 2 continuous failures → block write/edit until think{debug}.
    // bash intentionally stays free — the model must be able to probe/verify while armed.
    if (brain.needsDebugThink && (ev?.toolName === "write" || ev?.toolName === "edit")) {
      brain.stats.block++;
      (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: "needsDebugThink", reason: "2 continuous failures require debug think" });
      if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} needsDebugThink`, "warning"); } catch {}
      return { block: true, reason: blockHint("needsDebugThink", "Blocked by pi-brain: 2 continuous failures — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retrying write/edit (bash is still free for probing).", "[brain:block — think{goal:'debug <task>', hypotheses:[cause, fix]} before write/edit]") } as any;
    }
  });

  // memory always: edits landed + plan done, but no remember yet → nudge once (2nd repeat → habit)
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    if (getBrainMode() !== "on") return;
    if (brain.hasWriteEdit && !brain.hasRemember && !brain.rule5Warned && isPlanDone()) {
      brain.rule5Warned = true;
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, reason: "hasWriteEdit without remember after plan done" });
      try { ctx?.ui?.notify?.("pi-brain: edits landed but not remembered — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
    } else if (brain.hasWriteEdit && !brain.hasRemember && brain.rule5Warned && isPlanDone()) {
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, pending: true });
      if (isVerbose()) try { ctx?.ui?.notify?.("brain:nudge Rule 5 still pending — call remember", "warning"); } catch {}
    }
  });
}