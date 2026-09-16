import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTO_TTL_MS } from "./knobs";
import { indexEpisode, scoreBase } from "./scoring";
import { brain, isPlanDone } from "./state";
import type { BrainEpisode } from "./types";
import { isNoiseBash, truncate } from "./util";

export function registerHooks(pi: ExtensionAPI) {
  const encodeAuto = async (cue: string, summary: string, markDirty = true) => {
    if (!summary) return;
    const ep: BrainEpisode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto", expiresAt: Date.now()+AUTO_TTL_MS };
    await (pi as any).appendEntry?.("brain:episode", ep); brain.episodes.set(ep.id, ep); indexEpisode(ep); brain.recallMemo.clear();
    if (markDirty) { brain.hasWriteEdit = true; brain.hasRemember = false; }
  };
  // T09: hippocampal hooks — auto-encode + consolidation (sleep replay) + T2 filter + T11 feedback
  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      const cue = `${ev.toolName}:${(ev.input?.path ?? "").toString().slice(0, 30)}`;
      const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
      await encodeAuto(cue, summary);
    } else if (ev?.toolName === "bash" && !ev?.isError) {
      const cmd: string = (ev.input?.command ?? "").toString();
      const output: string = (ev.content?.[0]?.text ?? ev.result ?? "").toString();
      const isNoise = isNoiseBash(cmd, output);
      if (/passed|success|fixed|done|ok/i.test(output) && output.length > 20) {
        const best = [...brain.episodes.values()].filter(e=>e.source==="remember").map(e=>({e,s:scoreBase(e,cmd)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s)[0]?.e;
        if (best) { best.ts = Date.now(); brain.recallMemo.clear(); }
      }
      if (isPlanDone() && brain.hasRemember) {
        if (isNoise) return;
        await encodeAuto(`bash:${cmd.slice(0,30)}`, output.slice(0, 200), false);
      } else {
        if (isNoise) return;
        await encodeAuto(`bash:${cmd.slice(0,30)}`, output.slice(0, 200));
      }
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
    // unhappy path: only write/edit/bash failures block retry (narrowed from "any failure")
    if (ev?.isError && ["write", "edit", "bash"].includes(ev?.toolName)) {
      brain.needsDebugThink = true;
      brain.needsPlanUpdate = false;
      brain.thinkSatisfied = false;
      try { (ctx as any)?.ui?.notify?.("Strict unhappy path: failure detected — call think{goal:'debug <task>', hypotheses:[...]} before retry.", "warning"); } catch {}
      const hint = "\n[ brain: failure requires debug think — call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry ]";
      const cur = ev.content?.[0]?.text ?? "";
      return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
    }
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    // rm -rf guard first (highest priority) — covers rm -fr / -r -f / --recursive --force
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

  // Rule 5: encode-or-it-didn't-happen — once after plan done (not per-turn)
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    if (brain.brainStrict && brain.hasWriteEdit && !brain.hasRemember && !brain.rule5Warned && isPlanDone()) {
      brain.rule5Warned = true;
      try { ctx?.ui?.notify?.("Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
    }
  });
  // before_provider_request deleted — merged into context dedup+trim (one prune, not two)
}