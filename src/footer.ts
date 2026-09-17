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
    // Fallbacks are PLAIN text (no raw ANSI) so RPC-mode status never leaks escape sequences.
    if (enabled) {
      try { return theme.bold(theme.fg("accent", rawOn)); } catch { return rawOn; }
    } else {
      try { return theme.fg("muted", rawOff); } catch { return rawOff; }
    }
  } catch {
    return enabled ? rawOn : rawOff;
  }
}

export function setFooter(pi: ExtensionAPI, ctx: any, enabled: boolean) {
  const label = footerLabel(ctx, enabled);
  try { ctx?.ui?.setStatus?.("brain", label); } catch {}
  // also try pi.ui if ctx missing (session_start ctx may be minimal)
  try { (pi as any).ui?.setStatus?.("brain", label); } catch {}
}
