import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setFooter } from "./footer";
import { brain, getBrainMode, writeMode } from "./state";

export function registerCommand(pi: ExtensionAPI) {
  // /pi-brain — one guarded mode: silent while working, tutor after 2 failures, memory always.
  // Legacy "strict"/"guided" are accepted as aliases for "on" (the ceremony was removed).
  pi.registerCommand("pi-brain", {
    description: "Toggle pi-brain: /pi-brain on (guarded) | /pi-brain off | /pi-brain status",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["on", "off", "status"];
      const f = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return f.length ? f.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const persist = async (mode: "on" | "off") => {
        (brain as any).brainMode = mode;
        (brain as any).failureCount = 0;
        brain.thinkSatisfied = false;
        brain.hasRecall = false;
        brain.needsDebugThink = false;
        brain.needsPlanUpdate = false;
        brain.hasWriteEdit = false;
        brain.hasRemember = false;
        (brain as any).hasPlan = false;
        writeMode(mode);
        await (pi as any).appendEntry?.("brain:mode", { mode, enabled: mode === "on", ts: Date.now() });
        setFooter(pi, ctx, mode === "on");
        (pi as any).events?.emit?.("brain:mode", { mode, enabled: mode === "on" });
      };
      if (arg === "on" || arg === "strict" || arg === "guided" || arg === "enable" || arg === "guide") {
        await persist("on");
        const legacy = (arg === "strict" || arg === "guided") ? " (legacy mode merged — \"on\" is the single guarded mode)" : "";
        ctx.ui.notify(`pi-brain: ON — memory always · fail twice → think{debug} · remember when done.${legacy}`, "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "default") {
        await persist("off");
        ctx.ui.notify("pi-brain: OFF — stock pi behavior restored.", "info");
        return;
      }
      if (arg === "status" || arg === "") {
        const mode = getBrainMode();
        const fc = (brain as any).failureCount ?? 0;
        const txt = `pi-brain: ${mode.toUpperCase()} — silent when working · tutor on 2 failures · memory always\nEpisodes: ${brain.episodes.size} | Deliberations: ${brain.deliberations.length} | Index: ${brain.tokenIndex.size} tokens | failures: ${fc}/2\nUsage: /pi-brain on | /pi-brain off | /pi-brain status`;
        ctx.ui.notify(txt, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain on | /pi-brain off | /pi-brain status`, "warning");
    },
  });
}