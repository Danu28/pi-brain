import type { BrainEpisode } from "./types";

// D1 gist — single responsibility: presentation (view) — extracted from scoring.ts (god util)
// Used by inject/session/creative/brain-status — scoring owns tokenize/score, gist owns rendering

export function estTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

export function gistForEpisode(e: BrainEpisode): string {
  const first = e.summary.split(/[.!?\n]/)[0]?.trim() || e.summary;
  const base = `${e.cue}: ${first}`;
  const tagPart = e.tags?.length ? ` [${e.tags.join(",")}]` : "";
  const raw = base + tagPart;
  return raw.length > 120 ? raw.slice(0, 117) + "..." : raw;
}

export function compressEpisodes(list: BrainEpisode[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const k = e.cue.toLowerCase().trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`- ${gistForEpisode(e)}`);
    if (out.length >= 3) break;
  }
  return out.join("\n");
}
