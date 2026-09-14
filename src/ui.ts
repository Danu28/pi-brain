import { brain } from "./state";

// Creative footer: glanceable pulse for pi-brain mode
// ON  = 🧠 ◉ STRICT — recall-only, write gated until think
// OFF = 🧠 ◉ OFF — dormant, no injection, no auto-encode
// Single source of truth — command + session_start + any future caller uses this.
// Space between 🧠 and ◉ fixes crowding; details trimmed to mode only per request.

export function footerText(enabled?: boolean): string {
  const on = enabled ?? brain.brainStrict;
  return on ? `🧠 ◉ STRICT` : `🧠 ◉ OFF`;
}

export function syncFooter(pi: any, ctx: any, enabled?: boolean) {
  const on = enabled ?? brain.brainStrict;
  const text = footerText(on);
  try { (pi as any)._brainStrict = on; } catch {}
  // always show pulse — ON = STRICT, OFF = OFF (glanceable, no hidden)
  try { ctx?.ui?.setStatus?.("brain", text); } catch {}
  try { (pi as any).ui?.setStatus?.("brain", text); } catch {}
  try { pi?.setStatus?.("brain", text); } catch {}
  // also emit for any custom status listeners
  try { (pi as any).events?.emit?.("brain:mode", { enabled: on, footer: text }); } catch {}
  return text;
}
