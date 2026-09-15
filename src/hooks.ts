// shim — canonical implementation lives in src/hooks/index.ts (PR3 split)
// kept for backward compat: `import { registerHooks } from "./hooks"` resolves to file, which re-exports dir
export { registerHooks } from "./hooks/index.js";
