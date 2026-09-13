import { MAX_BYTES, MAX_LINES } from "./knobs";

export function truncate(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n") + `\n[truncated ${lines.length - MAX_LINES} lines]`;
  const byteLen = typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : new TextEncoder().encode(text).length;
  if (byteLen > MAX_BYTES) {
    // backtrack to valid UTF-8 boundary — naive cut fixed (per-path cache if needed)
    if (typeof Buffer !== "undefined") text = Buffer.from(text, "utf8").slice(0, MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + "\n[truncated to 50KB]";
    else text = text.slice(0, MAX_BYTES) + "\n[truncated to 50KB]";
  }
  return text;
}

export function isNoiseBash(cmd: string, output: string): boolean {
  const c = cmd.trim().toLowerCase();
  if (!c) return true;
  // pure read/ls noise — human brain forgets (only if short)
  if (/^\s*(ls|cat|head|tail|grep|find|echo|pwd|which|whoami|env|printenv)\b/.test(c)) return output.length < 200;
  // git status/diff short noise
  if (/^\s*git\s+(status|diff\s*--stat|log\s+--oneline)/.test(c) && output.length < 200) return true;
  if (output.length < 30) return false; // don't hide short errors like ENOENT
  return false;
}