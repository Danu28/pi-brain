import { AUTO_TTL_MS } from "../knobs";
import { indexEpisode } from "../recall";
import { brain } from "../state";
import type { BrainEpisode } from "../types";
import { truncate } from "../util";

export async function encodeAutoEpisode(
  pi: any,
  cue: string,
  summary: string,
  markDirty: boolean,
) {
  if (!summary) return;
  const ep: BrainEpisode = {
    id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    cue: truncate(cue),
    summary: truncate(summary),
    ts: Date.now(),
    source: "auto",
    expiresAt: Date.now() + AUTO_TTL_MS,
  };
  await (pi as any).appendEntry?.("brain:episode", ep);
  brain.episodes.set(ep.id, ep);
  indexEpisode(ep);
  brain.recallMemo.clear();
  if (markDirty) {
    brain.hasWriteEdit = true;
    brain.hasRemember = false;
  }
}
