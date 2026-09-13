import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// /pi-brain on|off is global, not per-session (branch entries only live in one session)
export const MODE_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-brain.json");

export function readMode(): boolean | undefined {
  try {
    const v = JSON.parse(readFileSync(MODE_FILE, "utf8"));
    return typeof v?.enabled === "boolean" ? v.enabled : undefined;
  } catch {
    return undefined;
  }
}

export function writeMode(enabled: boolean) {
  try {
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, JSON.stringify({ enabled, ts: Date.now() }), "utf8");
  } catch {}
}