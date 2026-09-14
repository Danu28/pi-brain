import { brain } from "./state";

// Creative footer: glanceable pulse for pi-brain mode
// ON  = 🧠◉ STRICT — recall-only, write gated until think, shows episode count
// OFF = 🧠○ default — light inject, free
// Single source of truth — command + session_start + any future caller uses this.

export function footerText(enabled?: boolean): string {
  const on = enabled ?? brain.brainStrict;
  if (!on) return ""; // really off — footer hidden, not discoverable
  const n = brain.episodes.size;
  // creative: pulse dot + recall-only hint + count; keep under ~40 chars
  return `🧠◉ STRICT • recall-only • ${n} eps`;
}

export function syncFooter(pi: any, ctx: any, enabled?: boolean) {
  const on = enabled ?? brain.brainStrict;
  const text = footerText(on);
  try { (pi as any)._brainStrict = on; } catch {}
  // really off — clear status bar entry so not discoverable
  const statusVal: any = text || null;
  try { ctx?.ui?.setStatus?.("brain", statusVal); } catch {}
  try { (pi as any).ui?.setStatus?.("brain", statusVal); } catch {}
  try { pi?.setStatus?.("brain", statusVal); } catch {}
  // also emit for any custom status listeners
  try { (pi as any).events?.emit?.("brain:mode", { enabled: on, footer: text }); } catch {}
  return text;
}
