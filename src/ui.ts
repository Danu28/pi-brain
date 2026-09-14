import { brain } from "./state";

// Creative footer: glanceable pulse for pi-brain mode
// ON  = 🧠◉ STRICT — recall-only, write gated until think, shows episode count
// OFF = 🧠○ default — light inject, free
// Single source of truth — command + session_start + any future caller uses this.

export function footerText(enabled?: boolean): string {
  const on = enabled ?? brain.brainStrict;
  const n = brain.episodes.size;
  // creative: pulse dot + mode word + hint + count; keep under ~40 chars for status bar
  return on
    ? `🧠◉ STRICT • recall-only • ${n} eps`
    : `🧠○ default • light • ${n} eps`;
}

export function syncFooter(pi: any, ctx: any, enabled?: boolean) {
  const on = enabled ?? brain.brainStrict;
  const text = footerText(on);
  try { (pi as any)._brainStrict = on; } catch {}
  try { ctx?.ui?.setStatus?.("brain", text); } catch {}
  try { (pi as any).ui?.setStatus?.("brain", text); } catch {}
  try { pi?.setStatus?.("brain", text); } catch {}
  // also emit for any custom status listeners
  try { (pi as any).events?.emit?.("brain:mode", { enabled: on, footer: text }); } catch {}
  return text;
}
