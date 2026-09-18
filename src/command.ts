import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setFooter } from "./footer";
import { brain, getBrainMode, saveMemory, writeMode, MODE_SOURCE } from "./state";

export function registerCommand(pi: ExtensionAPI) {
  pi.registerCommand("pi-brain", {
    description: "Toggle brain mode: /pi-brain strict (block) | /pi-brain guided (nudge) | /pi-brain off | /pi-brain status",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["strict", "guided", "off", "status", "on", "help"];
      const f = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return f.length ? f.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const persist = async (mode: "strict" | "guided" | "off") => {
        brain.brainMode = mode;
        (brain as any).brainStrict = mode === "strict"; // compat shim for tests/docs
        brain.failureCount = 0;
        brain.thinkSatisfied = false;
        brain.hasRecall = false;
        brain.needsDebugThink = false;
        brain.hasWriteEdit = false;
        brain.hasRemember = false;
        brain.hasPlan = false;
        writeMode(mode as any);
        await saveMemory();
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
      if (arg === "status" || arg === "" || arg === "help") {
        const mode = getBrainMode();
        const fc = brain.failureCount ?? 0;
        const src = MODE_SOURCE ? ` (source: ${MODE_SOURCE})` : "";
        const txt = `pi-brain: ${mode.toUpperCase()}${src} (strict=block, guided=nudge, off=disabled)\nEpisodes: ${brain.episodes.size} | Deliberations: ${brain.deliberations.length} | Index: ${brain.tokenIndex.size} tokens | failures: ${fc}/2\nUsage: /pi-brain strict | /pi-brain guided | /pi-brain off | /pi-brain status (help)`;
        ctx.ui.notify(txt, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain strict | /pi-brain guided | /pi-brain off | /pi-brain status`, "warning");
    },
  });
}
