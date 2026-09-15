import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTO_TTL_MS } from "./knobs";
import { patchCodeFile } from "./code";
import { indexEpisode } from "./recall";
import { scoreBase } from "./scoring";
import { brain, isPlanDone, latestPlan } from "./state";
import type { BrainEpisode } from "./types";
import { isNoiseBash, truncate } from "./util";

// ── D2 hooks split: 3 logical sections — auto-encode / guards / lifecycle ──
// keep single file barrel for pi API (registerHooks) but isolate duties

// ── auto-encode ──
async function encodeAutoEpisode(pi: ExtensionAPI, cue: string, summary: string, markDirty: boolean) {
  if (!summary) return;
  const ep: BrainEpisode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto", expiresAt: Date.now()+AUTO_TTL_MS };
  await (pi as any).appendEntry?.("brain:episode", ep);
  brain.episodes.set(ep.id, ep);
  indexEpisode(ep);
  brain.recallMemo.clear();
  if (markDirty) { brain.hasWriteEdit = true; brain.hasRemember = false; }
}

// ── guards helpers ──
function isRmRfCommand(cmd: string): boolean {
  const low = cmd.toLowerCase();
  return /\brm\b/.test(low) && (/\s-[a-z]*r[a-z]*f/.test(low) || (low.includes("--recursive") && low.includes("--force")));
}
function isBashLogicalFail(output: string, isError: boolean, toolName: string): boolean {
  return toolName === "bash" && !isError && output.length > 20 && /\b(fail(ed)?|error|exception|ENOENT|not found|cannot|unable)\b/i.test(output) && !/\b(passed|success|ok\b)/i.test(output);
}

// ── lifecycle ──
async function nudgeRule5(ctx: any) {
  if (!brain.brainStrict) return;
  if (brain.hasWriteEdit && !brain.hasRemember && !brain.rule5Warned && isPlanDone()) {
    brain.rule5Warned = true;
    try { ctx?.ui?.notify?.("Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
  }
}

export function registerHooks(pi: ExtensionAPI) {
  // T09: hippocampal hooks — auto-encode + consolidation (sleep replay) + T2 filter + T11 feedback
  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    // v2 P2 — patch code index on file mutations (works even when strict off, keep code fresh)
    try {
      if (["write","edit"].includes(ev?.toolName) && ev?.input?.path) {
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        const p = String(ev.input.path);
        const rel = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[/\\]+/,"") : p;
        // only patch if cwd file and code index already built (lazy build will handle first)
        if (brain.codeBlocks.length) await patchCodeFile(cwd, rel).catch(()=>{});
      }
    } catch {}
    if (ctx?.signal?.aborted) return;
    if (!brain.brainStrict) return; // really off — no auto-encode, no failure tracking
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      const cue = `${ev.toolName}:${(ev.input?.path ?? "").toString().slice(0, 30)}`;
      const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
      await encodeAutoEpisode(pi, cue, summary, true);
      brain.consecutiveFailures = 0;
    } else if (ev?.toolName === "bash" && !ev?.isError) {
      const cmd: string = (ev.input?.command ?? "").toString();
      const output: string = (ev.content?.[0]?.text ?? ev.result ?? "").toString();
      // T2: skip noise bash
      const isNoise = isNoiseBash(cmd, output);
      // T11: usefulness feedback — if success keywords, touch best matching remember episode (reinforce)
      if (/passed|success|fixed|done|ok/i.test(output) && output.length > 20) {
        // find best remember episode that shares tokens with cmd
        const best = [...brain.episodes.values()].filter(e=>e.source==="remember").map(e=>({e,s:scoreBase(e,cmd)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0]?.e;
        if (best) { best.ts = Date.now(); brain.recallMemo.clear(); }
      }
      // DRY: single encode path — markDirty only if not (planDone && hasRemember)
      if (isNoise) return;
      const cue = `bash:${cmd.slice(0,30)}`;
      const summary = output.slice(0, 200);
      const markDirty = !(isPlanDone() && brain.hasRemember);
      await encodeAutoEpisode(pi, cue, summary, markDirty);
      brain.consecutiveFailures = 0;
    }
    if ((ev?.toolName === "remember" || ev?.toolName === "habit") && !ev?.isError) {
      // audit preview returns blocked:true but not isError — don't treat as persisted
      const blocked = (ev as any)?.details?.blocked === true || (ev as any)?.result?.blocked === true;
      if (!blocked) {
        brain.hasRemember = true;
        brain.hasWriteEdit = false;
        brain.rule5Warned = false;
      }
    }
    // unhappy path: failure → rethink — precise: strict + active plan + mutation tool + (isError or bash logical fail)
    // logical bash fail = output contains fail/error without success, even if isError false (tests, build)
    {
      const isMutation = ["write", "edit", "bash"].includes(ev?.toolName);
      const plan = latestPlan();
      const hasActivePlan = !!plan && !isPlanDone();
      if (brain.brainStrict && hasActivePlan && isMutation) {
        const output: string = (ev.content?.[0]?.text ?? ev.result ?? "").toString();
        const isFailure = ev.isError || isBashLogicalFail(output, ev.isError, ev.toolName);
        if (isFailure) {
          brain.consecutiveFailures = (brain.consecutiveFailures || 0) + 1;
          if (brain.consecutiveFailures < 2) {
            try { (ctx as any)?.ui?.notify?.("First failure (1/2) — next continuous mutation failure will trigger unhappy path. Consider think{goal:'debug ...'} early.", "warning"); } catch {}
            const hint = "\n[ brain: first failure (1/2) — next continuous write/edit/bash failure will require debug think → plan update before retry ]";
            const cur = ev.content?.[0]?.text ?? "";
            return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
          }
          brain.needsDebugThink = true;
          brain.needsPlanUpdate = false;
          brain.thinkSatisfied = false;
          try { (ctx as any)?.ui?.notify?.("Strict unhappy path: 2 continuous failures — call think{goal:'debug <Task N: " + (ev.toolName + ":" + (ev.input?.path ?? ev.input?.command ?? "").toString().slice(0,30)) + "', hypotheses:[cause,fix]} before retry.", "warning"); } catch {}
          const hint = "\n[ brain: 2 continuous failures → rethink — call think{goal:'debug <failed Task N: " + ev.toolName + ">', hypotheses:[root cause, fix]} then plan{id,done} before retry ]";
          const cur = ev.content?.[0]?.text ?? "";
          return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
        } else {
          // non-failure mutation resets streak (should not happen here, but success path already resets)
        }
      }
    }
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    if (!brain.brainStrict) {
      // really off — brain tools not discoverable/active (except brain-status + command)
      if (["remember", "recall", "think", "creative", "plan", "habit"].includes(ev.toolName)) {
        return { block: true, reason: "pi-brain is OFF — run /pi-brain on to enable. No injection, footer, or auto-encode active." } as any;
      }
      return; // non-brain tools pass through, no brain guards
    }
    // guards: rm -rf (highest priority)
    if (ev?.toolName === "bash") {
      const cmd: string = ev?.input?.command ?? "";
      if (isRmRfCommand(cmd)) {
        if (!ctx?.hasUI) return { block: true, reason: "Blocked by brain guard: rm -rf needs UI confirm" } as any;
        try {
          const ok = await ctx.ui.confirm("Dangerous", "Allow rm -rf?");
          if (!ok) return { block: true, reason: "Blocked by brain guard" } as any;
        } catch {
          return { block: true, reason: "Blocked by brain guard" } as any;
        }
      }
    }
    // unhappy path: block write/edit/bash until debug think + plan update
    if (brain.brainStrict && brain.needsDebugThink && ["write", "edit", "bash"].includes(ev?.toolName)) {
      return { block: true, reason: "Blocked by strict unhappy path: failure occurred — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retry." } as any;
    }
    if (brain.brainStrict && brain.needsPlanUpdate && ["write", "edit", "bash"].includes(ev?.toolName)) {
      return { block: true, reason: "Blocked by strict unhappy path: debug think done — now update plan{id,done} before retry." } as any;
    }
    // Rule 2: think-before-act (strict only, enforced)
    if (brain.brainStrict && (ev?.toolName === "write" || ev?.toolName === "edit")) {
      if (!brain.thinkSatisfied) {
        return { block: true, reason: "Blocked by strict workflow Rule 2: call think{goal,hypotheses} before write/edit. Deliberate 2-3 approaches first." } as any;
      }
    }
    // hasRemember now set in tool_result (post-success) — not here
  });

  // lifecycle: Rule 5 nudge once after plan done + task-end reindex (keeps search fresh, no restart)
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    await nudgeRule5(ctx);
    try {
      if (brain.codeBlocks.length && !brain.codeIndexing && brain.hasWriteEdit) {
        const cwd = (ctx as any)?.cwd ?? process.cwd();
        const { syncCodeIndex } = await import("./code.js");
        await (syncCodeIndex as any)(cwd, (ctx as any)?.signal).catch(()=>{});
        brain.hasWriteEdit = false;
      }
    } catch {}
  });
  // before_provider_request deleted — merged into context dedup+trim (one prune, not two)
}