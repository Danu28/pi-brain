import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox PI_CODING_AGENT_DIR so brain-mode writes land in a temp dir, never the developer's real ~/.pi/agent.
// (src/state.ts binds MODE_FILE at module load, so the env must be present before tests import it.)
export default defineConfig({
  test: {
    env: {
      PI_CODING_AGENT_DIR: join(tmpdir(), "pi-brain-vitest"),
    },
  },
});