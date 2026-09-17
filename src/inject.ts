import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain, getBrainMode } from "./state";

export const BRAIN_FLOW_NOTE = (mode: "strict" | "guided") =>
  `\n\n[brain:${mode}] happy: [recall?] → think → plan → batch exec → plan done → remember/habit → commit\n` +
  `unhappy: 2 consecutive fails → think{debug} → continue → plan done → remember → commit`;

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
    if (!followUp) {
      brain.thinkSatisfied = false;
      brain.hasRecall = false;
      brain.hasWriteEdit = false;
      brain.hasRemember = false;
      brain.rule5Warned = false;
      brain.hasPlan = false;
    }
    return undefined;
  });

  pi.on("context" as any, async (ev: any) => {
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    const mode = getBrainMode();
    let changed = false;

    if (mode === "strict" || mode === "guided") {
      const lu = lastUserMessage(msgs);
      if (lu && !lu.text.includes("[brain:")) {
        const followUp = isFollowUpPrompt(lu.text);
        if (!followUp) {
          const note = BRAIN_FLOW_NOTE(mode as "strict" | "guided");
          if (typeof lu.msg.content === "string") lu.msg.content += note;
          else if (Array.isArray(lu.msg.content)) lu.msg.content.push({ type: "text", text: note });
          changed = true;
        }
      }
    }

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
