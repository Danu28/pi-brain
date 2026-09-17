import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain, getBrainMode } from "./state";

// Clean inject — no system-prompt hijack. pi keeps its NATIVE dynamic system prompt
// (rebuilt from tool registry + skills + loader). We only append a small STATIC flow note
// to the end of the latest user message on new-task turns:
//   - static text = KV-cache friendly (byte-identical every turn, no dynamic content)
//   - plan progress / last think are NOT injected — already visible via their tool results
// Lean: the note carries the only workflow (memory always · tutor on 2 failures · remember).
// Enforcement lives in hooks.ts — code, not prompt. This note is steering only.

const BRAIN_FLOW_NOTE = `\n\n[brain:on] memory always · fail twice → think{goal:'debug …', hypotheses:[cause,fix]} · remember when done\n`;

const FOLLOWUP_RE = /^(yes|yeah|yep|y|ok|okay|k|go|continue|keep going|proceed|next|done|thanks|thank you|thx|ty|lgtm|sounds good|ship it|same|again|retry|stop|no|n|that'?s it|thats it|\.{3})$/i;
export function isFollowUpPrompt(prompt: string): boolean {
  const p = (prompt || "").trim();
  if (!p) return true;
  if (p.length <= 4) return true;
  if (FOLLOWUP_RE.test(p)) return true;
  return false;
}

function lastUserMessage(msgs: any[]): { msg: any; text: string } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return { msg: m, text: c };
    if (Array.isArray(c)) {
      for (let j = c.length - 1; j >= 0; j--) {
        const b = c[j];
        if (b && typeof b.text === "string") return { msg: m, text: b.text };
      }
    }
    return { msg: m, text: "" };
  }
  return null;
}

export function registerInjection(pi: ExtensionAPI) {
  pi.on("before_agent_start" as any, async (ev: any, _ctx: any) => {
    const followUp = isFollowUpPrompt(ev?.prompt ?? "");
    // flags reset only on a NEW task (substantive prompt). Follow-up turns (continue/go/yes)
    // keep hasRecall/thinkSatisfied/hasPlan sticky so no forced re-recall / re-think mid-task.
    if (!followUp) {
      brain.thinkSatisfied = false;
      brain.hasRecall = false;
      brain.hasWriteEdit = false;
      brain.hasRemember = false;
      brain.rule5Warned = false;
      (brain as any).hasPlan = false;
    }
    // failureCount persists across turns for 2-continuous detection — do not reset here.
    // No systemPrompt override, no custom message injection — pi native prompt stays intact.
    return undefined;
  });

  pi.on("context" as any, async (ev: any) => {
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    const mode = getBrainMode();
    let changed = false;

    // 1) Append static flow note to the LAST user message — new-task turns only, once
    //    (idempotent marker: skip if the message already carries a [brain: note).
    if (mode === "on") {
      const lu = lastUserMessage(msgs);
      if (lu && !lu.text.includes("[brain:")) {
        const followUp = isFollowUpPrompt(lu.text);
        if (!followUp) {
          const note = BRAIN_FLOW_NOTE;
          if (typeof lu.msg.content === "string") lu.msg.content += note;
          else if (Array.isArray(lu.msg.content)) lu.msg.content.push({ type: "text", text: note });
          changed = true;
        }
      }
    }

    // 2) clean dedup only for legacy injected brain blocks (nothing new injected today)
    const seen = new Set<string>();
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
      if (deduped.length !== msgs.length) brain.stats.dedup++;
      (pi as any).events?.emit?.("brain:context-inject", { mode });
      return { messages: deduped } as any;
    }
  });
}