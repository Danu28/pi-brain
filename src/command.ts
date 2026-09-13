import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain } from "./state";
import { writeMode } from "./storage";

export function registerCommand(pi: ExtensionAPI) {
  // /pi-brain command — strict gate: on = brain-only, off = default pi
  pi.registerCommand("pi-brain", {
    description: "Toggle strict brain mode: /pi-brain on (answer only from brain) | /pi-brain off (default pi) | /pi-brain status",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["on", "off", "status"];
      const f = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return f.length ? f.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const persist = async (enabled: boolean) => {
        brain.brainStrict = enabled;
        brain.thinkSatisfied = false;
        brain.needsDebugThink = false;
        brain.needsPlanUpdate = false;
        brain.hasWriteEdit = false;
        brain.hasRemember = false;
        writeMode(enabled);
        await (pi as any).appendEntry?.("brain:mode", { enabled, ts: Date.now() });
        try { (pi as any)._brainStrict = enabled; ctx?.ui?.setStatus?.("brain", enabled ? "brain: strict" : "brain: default"); } catch {}
        (pi as any).events?.emit?.("brain:mode", { enabled });
      };
      if (arg === "on" || arg === "enable" || arg === "strict") {
        await persist(true);
        ctx.ui.notify("pi-brain: ON — all queries answered strictly from brain episodes (recall-only). Use /pi-brain off to restore default.", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "default") {
        await persist(false);
        ctx.ui.notify("pi-brain: OFF — default pi behavior restored.", "info");
        return;
      }
      if (arg === "status" || arg === "") {
        const txt = `pi-brain: ${brain.brainStrict ? "ON (strict)" : "OFF (default)"}\nEpisodes: ${brain.episodes.size} | Deliberations: ${brain.deliberations.length} | Index: ${brain.tokenIndex.size} tokens\nUsage: /pi-brain on | /pi-brain off`;
        ctx.ui.notify(txt, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain on | /pi-brain off | /pi-brain status`, "warning");
    },
  });
}