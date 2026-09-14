import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brain } from "./state";
import type { Deliberation } from "./types";
import { truncate } from "./util";

// D4 deliberation — single owner: think owns deliberation, plan delegates (SRP)
// One reason to change: deliberation lifecycle (cap 10, truncate, event)

export async function createDeliberation(
  pi: ExtensionAPI,
  goal: string,
  hypotheses: string[],
  conclusion?: string,
): Promise<Deliberation> {
  const entry: Deliberation = {
    goal: truncate(goal),
    hypotheses: hypotheses.map(truncate),
    conclusion: conclusion ? truncate(conclusion) : undefined,
    ts: Date.now(),
  };
  brain.deliberations.push(entry);
  if (brain.deliberations.length > 10) brain.deliberations.shift();
  await (pi as any).appendEntry?.("brain:deliberation", entry);
  (pi as any).events?.emit?.("brain:deliberation", entry);
  return entry;
}
