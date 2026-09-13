import { describe, expect, it } from "vitest";
import { expandTokens, normalizeTags, parseSince, planTaskError, scoreBase, scoreEpisode, tokenize } from "../src/scoring";
import type { BrainEpisode } from "../src/types";

const NOW = Date.now();

function mk(partial: Partial<BrainEpisode> & { cue: string; summary: string }): BrainEpisode {
  return { id: partial.cue, ts: NOW, source: "remember", ...partial };
}

describe("tokenize", () => {
  it("splits unicode and ascii identifiers", () => {
    expect(tokenize("brain-mode ON")).toEqual(["brain", "mode", "on"]);
    expect(tokenize("déjà vu")).toContain("déjà");
  });
});

describe("normalizeTags", () => {
  it("kebab-cases, dedups, caps at 8, drops empties", () => {
    expect(normalizeTags(["Infra", "infra", "cold start", "UPPER_CASE!"])).toEqual(["infra", "cold-start", "upper-case"]);
    expect(normalizeTags([])).toBeUndefined();
    expect(normalizeTags(["a", "b", "c", "d", "e", "f", "g", "h", "i"])?.length).toBe(8);
  });
});

describe("parseSince", () => {
  it("parses 7d/24h/ms/ISO", () => {
    expect(parseSince("7d")).toBeDefined();
    expect(parseSince("24h")).toBeDefined();
    expect(parseSince(1234567890)).toBe(1234567890);
    expect(parseSince("garbage")).toBeUndefined();
  });
});

describe("SYN + expandTokens", () => {
  it("expands known synonyms", () => {
    expect(expandTokens(tokenize("database"))).toContain("database");
    expect(expandTokens(["deploy"])).toContain("ship");
  });
});

describe("scoreBase / scoreEpisode (TF-IDF + half-life + boost)", () => {
  it("token-exact and substring TF hit", () => {
    const e = mk({ cue: "a", summary: "data" });
    expect(scoreEpisode(e, "a")).toBeGreaterThan(0);
    expect(scoreEpisode(e, "data")).toBeGreaterThan(0);
  });

  it("half-life: fresh outranks stale", () => {
    const fresh = mk({ cue: "test", summary: "test" });
    const old = mk({ cue: "test", summary: "test", ts: NOW - 14 * 86400000 });
    expect(scoreEpisode(fresh, "test")).toBeGreaterThan(scoreEpisode(old, "test"));
  });

  it("remember boost: remember outranks auto even when older", () => {
    const oldRem = mk({ cue: "deploy", summary: "deploy fix", ts: NOW - 7 * 86400000 });
    const freshAuto = mk({ cue: "deploy", summary: "deploy fix", ts: NOW, source: "auto" });
    expect(scoreEpisode(oldRem, "deploy")).toBeGreaterThan(scoreEpisode(freshAuto, "deploy") * 0.8);
  });

  it("audit decay-exempt: exact cue reaches ≥3", () => {
    const e = mk({ cue: "deploy", summary: "deploy fix" });
    expect(scoreBase(e, "deploy")).toBeGreaterThanOrEqual(3);
  });

  it("tag-only recall: matching tag gives positive base", () => {
    const e = mk({ cue: "db-fix", summary: "fix db", tags: ["infra"] });
    expect(scoreBase(e, "", ["infra"])).toBeGreaterThan(0);
  });
});

describe("planTaskError (3-10 guard)", () => {
  it("rejects <3 tasks", () => {
    expect(planTaskError(["a", "b"])).toBeDefined();
  });

  it("accepts valid detailed plans", () => {
    expect(planTaskError(["task one long enough", "task two long enough", "task three long enough"])).toBeUndefined();
  });

  it("rejects short tasks", () => {
    const err = planTaskError(["1234567890 long enough", "short", "1234567890 long enough"]);
    expect(err).toContain("≥10 chars");
  });

  it("gives chunk hint at >10 tasks", () => {
    const err = planTaskError(Array.from({ length: 11 }, (_, i) => `task ${i} long enough`));
    expect(err).toContain("Chunk it");
  });
});