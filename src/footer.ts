import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain } from "./state";

// Creative footer: brain icon + colored ON/OFF — always in sync
export function footerLabel(ctx: any, enabled: boolean): string {
  const rawOn = "🧠 ON";
  const rawOff = "🧠 OFF";
  try {
    const theme = ctx?.ui?.theme ?? (ctx as any)?.theme;
    if (!theme) return enabled ? rawOn : rawOff;
    // ON: accent + bold + slightly brighter — stands out
    // OFF: muted + dim — visible but quiet
    if (enabled) {
      // try accent first, fallback to green
      try { return theme.bold(theme.fg("accent", rawOn)); } catch { return `\x1b[1m\x1b[32m${rawOn}\x1b[0m`; }
    } else {
      try { return theme.fg("muted", rawOff); } catch { return `\x1b[2m\x1b[90m${rawOff}\x1b[0m`; }
    }
  } catch {
    return enabled ? rawOn : rawOff;
  }
}

export function setFooter(pi: ExtensionAPI, ctx: any, enabled: boolean) {
  const label = footerLabel(ctx, enabled);
  try { ctx?.ui?.setStatus?.("brain", label); } catch {}
  try { (pi as any)._brainStrict = enabled; } catch {}
  // also try pi.ui if ctx missing (session_start ctx may be minimal)
  try { (pi as any).ui?.setStatus?.("brain", label); } catch {}
}
