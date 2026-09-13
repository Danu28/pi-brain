import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "./command";
import { registerHooks } from "./hooks";
import { registerInjection } from "./inject";
import { registerSessionHandlers } from "./session";
import { registerTools } from "./tools/index";

// pi-brain — human brain → pi extension
// 5-step: Question→Delete→Simplify→Accelerate→Automate
// One factory, one Map — no class/DI (T01 gate: no SNN/vector DB/BCI/daemon)
// Narrow entry point: re-exports everything, easy to audit.

export default function (pi: ExtensionAPI) {
  registerSessionHandlers(pi); // TUI renderers + session_start waking + compaction + shutdown
  registerTools(pi);           // remember / recall / think / creative-thinking / plan / habit / brain-status
  registerCommand(pi);         // /pi-brain on|off|status
  registerInjection(pi);       // before_agent_start (strict/default inject) + context dedup
  registerHooks(pi);           // tool_result auto-encode + tool_call guards + turn_end nudge
}