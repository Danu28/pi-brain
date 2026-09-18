import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain } from "./state";

// Creative footer: brain icon + colored ON/OFF + counts — always in sync (S17)
export function footerLabel(ctx: any, enabled: boolean): string {
  const count = brain.episodes.size;
  const plan = brain.cachedLatestPlan ?? [...brain.plans.values()].sort((a,b)=> b.ts - a.ts)[0] ?? null;
  const planInfo = plan ? ` • ${plan.tasks.filter((t:any)=>t.done).length}/${plan.tasks.length}` : "";
  const pct = (()=> { try { const u = (ctx as any)?.getContextUsage?.() ?? (ctx as any)?.usage; return u?.percent ?? null; } catch { return null; }})();
  const pctStr = pct!==null ? ` • ${pct}%` : "";
  const rawOn = `🧠 ON ${count}${planInfo}${pctStr}`;
  const rawOff = `🧠 OFF ${count}`;
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

export function footerTooltip(): string {
  const mode = brain.brainMode ?? "off";
  const fc = brain.failureCount ?? 0;
  const lastPlan = brain.cachedLatestPlan?.goal ?? [...brain.plans.values()].sort((a,b)=> b.ts-a.ts)[0]?.goal ?? "none";
  return `mode:${mode} episodes:${brain.episodes.size} failures:${fc}/2 lastPlan:${lastPlan.slice(0,40)}`;
}
export function setFooter(pi: ExtensionAPI, ctx: any, enabled: boolean) {
  const label = footerLabel(ctx, enabled);
  const tooltip = footerTooltip();
  try { ctx?.ui?.setStatus?.("brain", label, tooltip); } catch { try { ctx?.ui?.setStatus?.("brain", label); } catch {} }
  try { (pi as any).ui?.setStatus?.("brain", label, tooltip); } catch { try { (pi as any).ui?.setStatus?.("brain", label); } catch {} }
}
