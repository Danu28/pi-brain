import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setFooter } from "./footer";
import { brain, saveMemory, writeMode } from "./state";

export function registerCommand(pi: ExtensionAPI) {
  // /pi-brain command — strict=block, guided=nudge, off=disabled
  pi.registerCommand("pi-brain", {
    description: "Toggle brain mode: /pi-brain strict (block) | /pi-brain guided (nudge) | /pi-brain off | /pi-brain status",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["strict", "guided", "off", "status", "on"];
      const f = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return f.length ? f.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const persist = async (mode: "strict" | "guided" | "off") => {
        (brain as any).brainMode = mode;
        brain.brainStrict = mode === "strict";
        (brain as any).failureCount = 0;
        brain.thinkSatisfied = false;
        brain.hasRecall = false;
        brain.needsDebugThink = false;
        brain.needsPlanUpdate = false;
        brain.hasWriteEdit = false;
        brain.hasRemember = false;
        (brain as any).hasPlan = false;
        writeMode(mode as any);
        saveMemory(); // keep the sidecar snapshot in sync with the toggle
        await (pi as any).appendEntry?.("brain:mode", { mode, enabled: mode === "strict", ts: Date.now() });
        setFooter(pi, ctx, mode === "strict");
        (pi as any).events?.emit?.("brain:mode", { mode, enabled: mode === "strict" });
      };
      if (arg === "strict" || arg === "on" || arg === "enable") {
        await persist("strict");
        ctx.ui.notify("pi-brain: STRICT — hard blocks enforced. Happy: recall→think→plan→batch→plan done→remember. Unhappy: 2 continuous failures → BLOCK until think{debug}. Use /pi-brain guided or /pi-brain off.", "info");
        return;
      }
      if (arg === "guided" || arg === "guide") {
        await persist("guided");
        ctx.ui.notify("pi-brain: GUIDED — flow guided (no hard blocks except rm -rf). Happy: recall→think→plan→batch→plan done→remember. Unhappy: 2 continuous failures → NUDGE think{debug}. Use /pi-brain strict or /pi-brain off.", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "default") {
        await persist("off");
        ctx.ui.notify("pi-brain: OFF — default pi behavior restored.", "info");
        return;
      }
      if (arg === "status" || arg === "") {
        const mode = (brain as any).brainMode ?? (brain.brainStrict ? "strict" : "off");
        const fc = (brain as any).failureCount ?? 0;
        const txt = `pi-brain: ${mode.toUpperCase()} (strict=block, guided=nudge, off=disabled)\nEpisodes: ${brain.episodes.size} | Deliberations: ${brain.deliberations.length} | Index: ${brain.tokenIndex.size} tokens | failures: ${fc}/2\nUsage: /pi-brain strict | /pi-brain guided | /pi-brain off | /pi-brain status`;
        ctx.ui.notify(txt, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain strict | /pi-brain guided | /pi-brain off | /pi-brain status`, "warning");
    },
  });
}