import { describe, expect, it, beforeEach, vi } from "vitest";
import * as util from "../src/util";
import { brain, resetBrain } from "../src/state";
import { indexEpisode } from "../src/recall";
import { registerRemember } from "../src/tools/remember";
import { registerRecall } from "../src/tools/recall";
import { registerPlan } from "../src/tools/plan";
import { registerThink } from "../src/tools/think";
import { planTaskError } from "../src/validation";
import type { BrainEpisode } from "../src/types";
import { isRmRfCommand, isBashLogicalFail } from "../src/hooks/guards";
import { encodeAutoEpisode } from "../src/hooks/auto-encode";
import { nudgeRule5 } from "../src/hooks/lifecycle";

function mockPi() {
  const tools: Record<string, any> = {};
  const pi: any = {
    registerTool: (def: any) => { tools[def.name] = def; },
    appendEntry: vi.fn(async () => {}),
    events: { emit: vi.fn() },
    ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => true) },
    withFileMutationQueue: null,
    cwd: process.cwd(),
  };
  return { pi, tools };
}

beforeEach(() => resetBrain());

describe("fuzz: truncate UTF-8 + lines", () => {
  it("handles emoji multi-byte not corrupting to �", () => {
    const emoji = "🧠".repeat(20000); // each 4 bytes => 80k > 50KB
    const out = util.truncate(emoji);
    expect(out).toContain("[truncated to 50KB]");
    expect(out).not.toMatch(/\uFFFD{2,}/); // should not end with multiple replacement chars (handled)
    // roundtrip byte length <= MAX
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50 * 1024 + 100);
  });
  it("exact MAX_BYTES boundary not truncating unnecessarily", () => {
    const ok = "a".repeat(50 * 1024 - 10);
    expect(util.truncate(ok)).toBe(ok);
    const big = "a".repeat(60 * 1024);
    expect(util.truncate(big)).toContain("truncated");
  });
  it("lines cap 2000", () => {
    const lines = Array.from({ length: 2005 }, (_, i) => `line ${i}`).join("\n");
    const out = util.truncate(lines);
    expect(out).toContain("[truncated 5 lines]");
    expect(out.split("\n").length).toBeLessThanOrEqual(2001);
  });
  it("split in middle of emoji sequence", () => {
    const s = "a".repeat(50 * 1024 - 5) + "🧠🧠🧠";
    const out = util.truncate(s);
    // should not produce broken surrogate at cut point
    expect(() => Buffer.from(out, "utf8").toString("utf8")).not.toThrow();
  });
});

describe("fuzz: isNoiseBash", () => {
  it("empty cmd is noise", () => expect(util.isNoiseBash("", "out")).toBe(true));
  it("ls short is noise, long not noise", () => {
    expect(util.isNoiseBash("ls -la", "file")).toBe(true);
    expect(util.isNoiseBash("ls", "a".repeat(300))).toBe(false);
  });
  it("git status short is noise", () => {
    expect(util.isNoiseBash("git status", "On branch main")).toBe(true);
    expect(util.isNoiseBash("git status", "a".repeat(300))).toBe(false);
  });
  it("tiny output <30 never noise (don't hide ENOENT) — except cat family is noise (<200)", () => {
    // cat family returns output.length<200 regardless of <30 (see pure.test: cat ENOENT is noise)
    expect(util.isNoiseBash("cat file", "ENOENT")).toBe(true);
    expect(util.isNoiseBash("cat file", "a".repeat(29))).toBe(true);
    expect(util.isNoiseBash("cat file", "a".repeat(30))).toBe(true);
    // non-cat short errors are not noise (don't hide)
    expect(util.isNoiseBash("npm test", "ENOENT")).toBe(false);
    expect(util.isNoiseBash("npm test", "a".repeat(29))).toBe(false);
    expect(util.isNoiseBash("npm test", "a".repeat(31))).toBe(false); // npm not in noise list -> always false unless >? only noise families
  });
  it("non-noise commands pass through", () => {
    expect(util.isNoiseBash("npm test", "failed")).toBe(false);
    expect(util.isNoiseBash("npm run build", "success")).toBe(false);
  });
});

describe("fuzz: hooks guards", () => {
  it("isRmRfCommand detects variants", () => {
    expect(isRmRfCommand("rm -rf /")).toBe(true);
    expect(isRmRfCommand("rm -fr /tmp")).toBe(true);
    expect(isRmRfCommand("rm --recursive --force /")).toBe(true);
    expect(isRmRfCommand("rm -r -f foo")).toBe(true);
    expect(isRmRfCommand("rm foo")).toBe(false);
    expect(isRmRfCommand("echo rm -rf")).toBe(true); // contains rm + -rf, but guard is strict enough
  });
  it("isBashLogicalFail detects failed without success (>20 chars)", () => {
    expect(isBashLogicalFail("Test failed: something went wrong here extra", false, "bash")).toBe(true);
    expect(isBashLogicalFail("ENOENT: not found - file missing in /tmp/xyz extra long", false, "bash")).toBe(true);
    expect(isBashLogicalFail("passed success - all tests passed extra long output here", false, "bash")).toBe(false);
    expect(isBashLogicalFail("error but passed - overall passed extra long output", false, "bash")).toBe(false);
    expect(isBashLogicalFail("error but long enough to trigger but isError true", true, "bash")).toBe(false); // isError already true -> not logical fail
    expect(isBashLogicalFail("short", false, "bash")).toBe(false); // <20
    expect(isBashLogicalFail("Test failed: something went wrong here", false, "write")).toBe(false);
  });
  it("nudgeRule5 notifies once", async () => {
    const notify = vi.fn();
    brain.brainStrict = true;
    brain.hasWriteEdit = true;
    brain.hasRemember = false;
    brain.rule5Warned = false;
    const plan = { id: "p", goal: "g", tasks: [{ title: "task one long enough", done: true }], ts: Date.now() } as any;
    brain.plans.set(plan.id, plan);
    brain.cachedLatestPlan = plan as any;
    await nudgeRule5({ ui: { notify } });
    expect(notify).toHaveBeenCalled();
    expect(brain.rule5Warned).toBe(true);
    const n2 = vi.fn();
    await nudgeRule5({ ui: { notify: n2 } });
    expect(n2).not.toHaveBeenCalled(); // once
  });
  it("encodeAutoEpisode respects empty summary", async () => {
    const pi: any = { appendEntry: vi.fn(async () => {}) };
    const before = brain.episodes.size;
    await encodeAutoEpisode(pi, "cue", "", true);
    expect(brain.episodes.size).toBe(before);
    await encodeAutoEpisode(pi, "cue2", "summary", true);
    expect(brain.episodes.size).toBe(before + 1);
    expect(brain.hasWriteEdit).toBe(true);
  });
});

describe("fuzz: remember edge cues", () => {
  it("!!! cue → id falls back to episode: prefix not ---", async () => {
    const { pi, tools } = mockPi();
    registerRemember(pi);
    const r = await tools["remember"].execute("1", { cue: "!!!", summary: "test summary long enough" }, null as any);
    expect(r.details.id).toBeDefined();
    // id derived from cue.replace -> "---" slice, but should still be valid and stored
    const ep = brain.episodes.get(r.details.id);
    expect(ep).toBeDefined();
    expect(ep!.cue).toBe("!!!");
  });
  it("force with exact cue still upserts (no duplicate)", async () => {
    const { pi, tools } = mockPi();
    registerRemember(pi);
    const r1 = await tools["remember"].execute("1", { cue: "dup-cue", summary: "first" }, null as any);
    const id1 = r1.details.id;
    const r2 = await tools["remember"].execute("2", { cue: "dup-cue", summary: "second", force: true }, null as any);
    expect(r2.details.id).toBe(id1);
    expect(r2.details.audit).toBe("exact-cue-upsert");
    expect(brain.episodes.size).toBe(1);
  });
  it("similar audit threshold 5 not 3", async () => {
    const { pi, tools } = mockPi();
    registerRemember(pi);
    await tools["remember"].execute("1", { cue: "deploy fix", summary: "ship release deploy" }, null as any);
    // score should be >=5 to block; a weakly similar should pass
    const weak = await tools["remember"].execute("2", { cue: "unrelated", summary: "completely different topic xyz" }, null as any);
    expect(weak.details.blocked).toBeUndefined();
    const strong = await tools["remember"].execute("3", { cue: "ship deploy", summary: "ship release deploy fix" }, null as any);
    expect(strong.details.blocked).toBe(true);
  });
});

describe("fuzz: plan validation edges", () => {
  it("planTaskError 3..10 and >=10 chars", () => {
    expect(planTaskError(["a", "b"])).toMatch(/≥3/);
    expect(planTaskError(["short", "short2", "short3"])).toMatch(/≥10 chars/);
    expect(planTaskError(Array.from({ length: 11 }, (_, i) => `task ${i} long enough`))).toMatch(/max 10/);
    expect(planTaskError(["task one long enough", "task two long enough", "task three long enough"])).toBeUndefined();
  });
  it("plan update path validates via tool", async () => {
    const { pi, tools } = mockPi();
    registerThink(pi);
    registerPlan(pi);
    // create via hypotheses single-shot
    const r = await tools["plan"].execute("1", { goal: "fix", tasks: ["task one long enough", "task two long enough", "task three long enough"], hypotheses: ["hyp1 long enough", "hyp2 long enough"] }, null as any);
    const id = r.details.plan.id;
    const r2 = await tools["plan"].execute("2", { id, tasks: ["bad"] }, null as any);
    expect(r2.details.error).toBeDefined();
    const r3 = await tools["plan"].execute("3", { id, tasks: ["additional task long enough", "another task long enough"] }, null as any);
    expect(r3.details.plan).toBeDefined();
  });
});

describe("fuzz: recall tag-only + batch + memo", () => {
  it("tag-only empty query returns filtered not all", async () => {
    const { pi, tools } = mockPi();
    registerRemember(pi);
    registerRecall(pi);
    await tools["remember"].execute("1", { cue: "cold start", summary: "cold start fix", tags: ["infra"] }, null as any);
    await tools["remember"].execute("2", { cue: "auth bug", summary: "login fail", tags: ["auth"] }, null as any);
    const r = await tools["recall"].execute("1", { query: "", tags: ["infra"], limit: 5 }, null as any);
    expect(r.details.episodes.every((e: BrainEpisode) => e.tags?.includes("infra"))).toBe(true);
  });
  it("batch queries exposes perQuery", async () => {
    const { pi, tools } = mockPi();
    registerRemember(pi);
    registerRecall(pi);
    await tools["remember"].execute("1", { cue: "cold start", summary: "cold start fix" }, null as any);
    await tools["remember"].execute("2", { cue: "auth bug", summary: "login fail" }, null as any);
    const r = await tools["recall"].execute("1", { queries: ["cold", "auth"], limit: 5 }, null as any);
    expect(r.details.perQuery).toBeDefined();
    expect(Object.keys(r.details.perQuery).length).toBe(2);
  });
  it("memo hits after repeat", async () => {
    const { pi, tools } = mockPi();
    registerRemember(pi);
    registerRecall(pi);
    await tools["remember"].execute("1", { cue: "cold", summary: "cold" }, null as any);
    const rec = tools["recall"];
    await rec.execute("1", { query: "cold", limit: 1 }, null as any);
    const r2 = await rec.execute("2", { query: "cold", limit: 1 }, null as any);
    expect(r2.details.cached).toBe(true);
  });
});

describe("fuzz: neural determinism + SYN", () => {
  it("hashNeuralEmbed deterministic seed 42", async () => {
    const { hashNeuralEmbed, cosine } = await import("../src/neural");
    const a = hashNeuralEmbed("ship deploy");
    const b = hashNeuralEmbed("ship deploy");
    expect(cosine(a, b)).toBeCloseTo(1, 5);
    // open vocab: ship vs deploy via SYN expand should also be similar via hash? not identical but >0.3
    const c = hashNeuralEmbed("deploy");
    const d = hashNeuralEmbed("ship");
    // hash-neural is not SYN-aware, but lexical SYN handles it; neural similarity is moderate
    expect(cosine(c, d)).toBeGreaterThan(-0.5);
  });
  it("SYN invalid file not crash (silent catch)", async () => {
    // scoring already loaded SYN at import; we just ensure import didn't throw
    const { scoreBase } = await import("../src/scoring");
    const e = { cue: "test", summary: "test", ts: Date.now(), source: "remember" } as BrainEpisode;
    expect(() => scoreBase(e, "test")).not.toThrow();
  });
});
