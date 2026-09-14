import { describe, expect, it, beforeEach } from "vitest";
import { tokenize, normalizeTags, parseSince, expandTokens, scoreBase, scoreEpisode, avgIdf, gistForEpisode, compressEpisodes, estTokens } from "../src/scoring";
import { planTaskError } from "../src/validation";
import { truncate, isNoiseBash } from "../src/util";
import * as knobs from "../src/knobs";
import { brain, resetBrain } from "../src/state";
import { indexEpisode } from "../src/recall";
import type { BrainEpisode } from "../src/types";

beforeEach(() => resetBrain());

function mk(p: Partial<BrainEpisode> & { cue:string; summary:string }): BrainEpisode {
  return { id: p.id ?? p.cue, ts: Date.now(), source: "remember", ...p } as BrainEpisode;
}

describe("pure: tokenize / normalize / parseSince / expand", () => {
  it("handles unicode, kebab, limits, and dates", () => {
    expect(tokenize("brain-mode ON")).toEqual(["brain","mode","on"]);
    expect(tokenize("déjà vu")).toContain("déjà");
    expect(normalizeTags(["Infra","infra","cold start","UPPER_CASE!"])).toEqual(["infra","cold-start","upper-case"]);
    expect(normalizeTags([])).toBeUndefined();
    expect(normalizeTags(["a","b","c","d","e","f","g","h","i"])?.length).toBe(8);
    expect(parseSince("7d")).toBeDefined();
    expect(parseSince("24h")).toBeDefined();
    expect(parseSince(1234567890)).toBe(1234567890);
    expect(parseSince("garbage")).toBeUndefined();
    expect(expandTokens(["deploy"])).toContain("ship");
    expect(expandTokens(tokenize("database"))).toContain("database");
  });
});

describe("pure: scoring core", () => {
  it("scoreBase/scoreEpisode TF, half-life, boost, tag-only", () => {
    const e = mk({ cue:"deploy", summary:"deploy fix", tags:["infra"] });
    expect(scoreBase(e, "deploy")).toBeGreaterThanOrEqual(3);
    expect(scoreEpisode(mk({ cue:"a", summary:"data" }), "a")).toBeGreaterThan(0);
    const fresh = mk({ cue:"test", summary:"test" });
    const old = mk({ cue:"test", summary:"test", ts: Date.now()-14*86400000 });
    expect(scoreEpisode(fresh,"test")).toBeGreaterThan(scoreEpisode(old,"test"));
    const oldRem = mk({ cue:"deploy", summary:"deploy fix", ts:Date.now()-7*86400000 });
    const freshAuto = mk({ cue:"deploy", summary:"deploy fix", ts:Date.now(), source:"auto" as any });
    expect(scoreEpisode(oldRem,"deploy")).toBeGreaterThan(scoreEpisode(freshAuto,"deploy")*0.8);
    expect(scoreBase(mk({ cue:"db-fix", summary:"fix db", tags:["infra"] }), "", ["infra"])).toBeGreaterThan(0);
    // dedup tag boost: filter overlapping expanded shouldn't double count
    const s1 = scoreBase(e, "infra", ["infra"]);
    expect(s1).toBeGreaterThan(0);
  });

  it("avgIdf, gist, compress, estTokens", () => {
    expect(avgIdf([])).toBe(1);
    const rare = mk({ cue:"rareterm", summary:"rareterm" });
    brain.episodes.set(rare.id, rare); indexEpisode(rare);
    expect(avgIdf(["rareterm"])).toBeGreaterThanOrEqual(1);
    expect(gistForEpisode(mk({ cue:"my-cue", summary:"First. Second.", tags:["t"] }))).toContain("my-cue:");
    expect(gistForEpisode(mk({ cue:"c", summary:"a".repeat(200) })).length).toBeLessThanOrEqual(120);
    const dup1 = mk({ id:"1", cue:"dup", summary:"s1", ts:Date.now() });
    const dup2 = mk({ id:"2", cue:"dup", summary:"s2", ts:Date.now()-1000 });
    expect(compressEpisodes([dup1,dup2]).split("\n").length).toBe(1);
    expect(estTokens("hello world")).toBe(Math.ceil(11/3.5));
  });
});

describe("pure: validation + util + knobs", () => {
  it("planTaskError guards 3-10 and details", () => {
    expect(planTaskError(["a","b"])).toBeDefined();
    expect(planTaskError(["task one long enough","task two long enough","task three long enough"])).toBeUndefined();
    expect(planTaskError(["1234567890 long enough","short","1234567890 long enough"])!).toContain("≥10 chars");
    expect(planTaskError(Array.from({length:11},(_,i)=>`task ${i} long enough`))!).toContain("Chunk it");
  });

  it("truncate limits lines and bytes", () => {
    expect(truncate("")).toBe("");
    const lines = Array.from({length:2005},(_,i)=>`line ${i}`).join("\n");
    expect(truncate(lines)).toContain("[truncated 5 lines]");
    const big = "a".repeat(60000);
    expect(truncate(big)).toContain("[truncated to 50KB]");
  });

  it("isNoiseBash and knobs", () => {
    expect(isNoiseBash("ls -la","file1")).toBe(true);
    expect(isNoiseBash("ls","a".repeat(300))).toBe(false);
    expect(isNoiseBash("git status","On branch")).toBe(true);
    expect(isNoiseBash("cat file","ENOENT")).toBe(true);
    expect(isNoiseBash("npm test","failed")).toBe(false);
    expect(isNoiseBash("","")).toBe(true);
    expect(knobs.MAX_BYTES).toBe(50*1024);
    expect(knobs.PRUNE_CAP).toBe(40);
    expect(knobs.TAG_BOOST).toBe(1.5);
  });
});
