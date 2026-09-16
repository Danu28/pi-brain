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
    // unhappy path: only write/edit/bash failures block retry
    if (ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      brain.needsDebugThink = true;
      brain.needsPlanUpdate = false;
      brain.thinkSatisfied = false;
      brain.hasRecall = false;
      try { (ctx as any)?.ui?.notify?.("Strict unhappy path: failure detected — call think{goal:'debug <task>', hypotheses:[...]} before retry.", "warning"); } catch {}
      (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: "needsDebugThink", reason: "failure" });
      const hint = "\n[ brain: failure requires debug think — call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry ]";
      const cur = ev.content?.[0]?.text ?? "";
      return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
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
    if (brain.brainStrict && brain.needsDebugThink && ["write", "edit", "bash"].includes(ev?.toolName)) {
      brain.stats.block++;
      (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: "needsDebugThink", reason: "failure requires debug think" });
      if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} needsDebugThink`, "warning"); } catch {}
      return { block: true, reason: "Blocked by strict unhappy path: failure occurred — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retry." } as any;
    }
    if (brain.brainStrict && brain.needsPlanUpdate && ["write", "edit", "bash"].includes(ev?.toolName)) {
      brain.stats.block++;
      (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: "needsPlanUpdate", reason: "debug think done — need plan update" });
      if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} needsPlanUpdate`, "warning"); } catch {}
      return { block: true, reason: "Blocked by strict unhappy path: debug think done — now update plan{id,done} before retry." } as any;
    }
    // Rule 1 clean: recall-first — block write/edit until explicit recall in strict mode
    if (brain.brainStrict && !brain.hasRecall && ["write", "edit"].includes(ev?.toolName)) {
      brain.stats.block++;
      (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 1, reason: "recall first" });
      if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 1 recall first — call recall{query} before write/edit`, "warning"); } catch {}
      return { block: true, reason: "Blocked by strict workflow Rule 1: call recall{query} first to check prior episodes (explicit, no auto-injection)." } as any;
    }
    // Rule 2: think-before-act
    if (brain.brainStrict && (ev?.toolName === "write" || ev?.toolName === "edit")) {
      if (!brain.thinkSatisfied) {
        brain.stats.block++;
        (pi as any).events?.emit?.("brain:block", { tool: ev?.toolName, rule: 2, reason: "think before act" });
        if (isVerbose()) try { (ctx as any)?.ui?.notify?.(`brain:block ${ev?.toolName} Rule 2 think first`, "warning"); } catch {}
        return { block: true, reason: "Blocked by strict workflow Rule 2: call think{goal,hypotheses} before write/edit. Deliberate 2-3 approaches first." } as any;
      }
    }
  });

  // Rule 5: encode-or-it-didn't-happen — clean: only nudge, never auto-encode
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    if (brain.brainStrict && brain.hasWriteEdit && !brain.hasRemember && !brain.rule5Warned && isPlanDone()) {
      brain.rule5Warned = true;
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, reason: "hasWriteEdit without remember after plan done" });
      try { ctx?.ui?.notify?.("Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
    } else if (brain.brainStrict && brain.hasWriteEdit && !brain.hasRemember && brain.rule5Warned && isPlanDone()) {
      brain.stats.nudge++;
      (pi as any).events?.emit?.("brain:nudge", { rule: 5, pending: true });
      if (isVerbose()) try { ctx?.ui?.notify?.("brain:nudge Rule 5 still pending — call remember", "warning"); } catch {}
    }
  });
}
