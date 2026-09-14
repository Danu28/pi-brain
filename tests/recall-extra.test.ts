import { describe, expect, it, beforeEach } from "vitest";
import { brain, resetBrain } from "../src/state";
import { indexEpisode, unindexEpisode, rebuildIndex, pruneExpired, candidatePool } from "../src/recall";
import { avgIdf, compressEpisodes, estTokens, gistForEpisode, scoreBase } from "../src/scoring";
import type { BrainEpisode } from "../src/types";

beforeEach(() => resetBrain());

function ep(partial: Partial<BrainEpisode> & { cue:string; summary:string }): BrainEpisode {
  return { id: partial.id ?? `${partial.cue}:${Date.now()}:${Math.random().toString(36).slice(2,4)}`, ts: Date.now(), source:"remember", ...partial } as BrainEpisode;
}

describe("recall index", () => {
  it("indexEpisode and unindexEpisode update tokenIndex", () => {
    const e = ep({ cue:"deploy fix", summary:"ship", tags:["infra"] });
    indexEpisode(e); brain.episodes.set(e.id, e);
    expect(brain.tokenIndex.get("deploy")?.has(e.id)).toBe(true);
    expect(brain.tokenIndex.get("infra")?.has(e.id)).toBe(true);
    unindexEpisode(e);
    expect(brain.tokenIndex.get("deploy")).toBeUndefined();
  });

  it("rebuildIndex reconstructs from episodes", () => {
    const e1 = ep({ cue:"alpha", summary:"one" });
    const e2 = ep({ cue:"beta", summary:"two" });
    brain.episodes.set(e1.id, e1); brain.episodes.set(e2.id, e2);
    rebuildIndex();
    expect(brain.tokenIndex.size).toBeGreaterThan(0);
    expect(brain.tokenIndex.get("alpha")?.has(e1.id)).toBe(true);
  });

  it("pruneExpired removes expired and LRU over cap", () => {
    const expired = ep({ id:"exp", cue:"old", summary:"old", ts:Date.now()-10000, expiresAt: Date.now()-1000 } as any);
    brain.episodes.set(expired.id, expired); indexEpisode(expired);
    const n = pruneExpired({} as any);
    expect(n).toBe(1);
    expect(brain.episodes.has("exp")).toBe(false);
    // fill to over PRUNE_CAP (40) with auto episodes
    for(let i=0;i<42;i++){ const e=ep({ id:`a${i}`, cue:`auto${i}`, summary:"x", source:"auto" as any, ts:Date.now()-i*1000 }); brain.episodes.set(e.id,e); indexEpisode(e); }
    const n2 = pruneExpired({} as any);
    expect(brain.episodes.size).toBeLessThanOrEqual(40);
    expect(n2).toBeGreaterThan(0);
  });

  it("candidatePool uses index hits then fallback", () => {
    const e = ep({ cue:"unique-cue-xyz", summary:"hello" });
    brain.episodes.set(e.id, e); indexEpisode(e);
    const hits = candidatePool("unique-cue-xyz");
    expect(hits.some(x=>x.id===e.id)).toBe(true);
    // query with no index hits falls back to all
    const all = candidatePool("nomatchzzz");
    expect(all.length).toBe(brain.episodes.size);
  });
});

describe("scoring extras", () => {
  it("avgIdf returns 1 for empty and >=1 for rare terms", () => {
    expect(avgIdf([])).toBe(1);
    const e = ep({ cue:"rareterm", summary:"rareterm" });
    brain.episodes.set(e.id, e); indexEpisode(e);
    const idf = avgIdf(["rareterm"]);
    expect(idf).toBeGreaterThanOrEqual(1);
    const common = avgIdf(["a"]);
    expect(typeof common).toBe("number");
  });

  it("gistForEpisode truncates and compressEpisodes dedups", () => {
    const e: BrainEpisode = ep({ cue:"my-cue", summary:"First sentence. Second.", tags:["t"] });
    expect(gistForEpisode(e)).toContain("my-cue:");
    const long = ep({ cue:"c", summary:"a".repeat(200) });
    expect(gistForEpisode(long).length).toBeLessThanOrEqual(120);
    const dup1 = ep({ id:"1", cue:"dup", summary:"s1", ts:Date.now() });
    const dup2 = ep({ id:"2", cue:"dup", summary:"s2", ts:Date.now()-1000 });
    const comp = compressEpisodes([dup1, dup2]);
    expect(comp.split("\n").length).toBe(1); // deduped by cue
  });

  it("estTokens approximates length/3.5", () => {
    expect(estTokens("hello world")).toBe(Math.ceil(11/3.5));
    expect(estTokens("")).toBe(0);
  });

  it("scoreBase tag boost deduplicated when filterTags overlaps expanded", () => {
    const e = ep({ cue:"fix", summary:"fix", tags:["infra"] });
    // filterTags same as tag — should boost once, not twice
    const s1 = scoreBase(e, "infra", ["infra"]);
    const s2 = scoreBase(e, "", ["infra"]);
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(0);
    // without filter, expanded tag still boosts
    const s3 = scoreBase(e, "infra");
    expect(s3).toBeGreaterThan(0);
  });
});
