import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "./command";
import { registerHooks } from "./hooks";
import { registerInjection } from "./inject";
import { registerSessionHandlers } from "./session";
import { registerTools } from "./tools";

// pi-brain — human brain → pi extension
// 5-step: Question→Delete→Simplify→Accelerate→Automate
// One factory, one Map — no class/DI (T01 gate: no SNN/vector DB/BCI/daemon)
// Narrow entry point: re-exports everything, easy to audit.

export default function (pi: ExtensionAPI) {
  registerSessionHandlers(pi); // TUI renderers + session_start waking + compaction + shutdown
  registerTools(pi);           // remember / recall / think / creative-thinking / plan / habit / brain-status
  registerCommand(pi);         // /pi-brain on|off|status
  registerInjection(pi);       // before_agent_start (strict/default inject) + context dedup
  registerHooks(pi);           // tool_result flags + tool_call guards + turn_end nudge
  // S15 re-enable habit SKILL.md indexing for .pi/skills/brain-*/SKILL.md
  try {
    (pi as any).on?.("resources_discover" as any, async () => {
      try {
        const { readdirSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const root = join(process.cwd(), ".pi", "skills");
        if (!existsSync(root)) return [];
        const entries = readdirSync(root, { withFileTypes: true });
        const skills = entries.filter((d:any)=> d.isDirectory() && d.name.startsWith("brain-"))
          .map((d:any)=> ({ kind: "skill", name: d.name, path: join(root, d.name, "SKILL.md")}))
          .filter((s:any)=> { try { return existsSync(s.path); } catch { return false; }});
        return skills;
      } catch { return []; }
    });
  } catch {}
}