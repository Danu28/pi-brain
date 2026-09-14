// validation — single responsibility: plan task-list validation (SRP extract from scoring.ts)
export function planTaskError(tasks: string[]): string | undefined {
  if (tasks.length < 3) return `plan requires ≥3 detailed tasks (got ${tasks.length}) — split into 3-10 well-structured steps. Example: ["analyze requirement & existing code","update index.ts core logic","update docs & verify"]`;
  if (tasks.length > 10) return `plan got ${tasks.length} tasks — max 10. Chunk it: create with the first 10, then append plan{id:"<id>", tasks:["remaining…"]}. Or merge related steps.`;
  const short = tasks.filter((t) => t.trim().length < 10);
  if (short.length) return `plan tasks must be detailed (≥10 chars each) — short: "${short[0].slice(0,30)}" — make each concrete and actionable (what file, what change)`;
  return undefined;
}
