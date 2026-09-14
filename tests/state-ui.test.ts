import { describe, expect, it, beforeEach, vi } from "vitest";
import { brain, resetBrain, latestPlan, isPlanDone, renderPlan } from "../src/state";
import { footerText, syncFooter } from "../src/ui";
import { truncate, isNoiseBash } from "../src/util";
import { planTaskError } from "../src/validation";
import type { BrainPlan } from "../src/types";

beforeEach(() => resetBrain());

describe("state", () => {
  it("resetBrain clears all maps and flags", () => {
    brain.episodes.set("a", { id:"a", cue:"a", summary:"s", ts:Date.now(), source:"remember" } as any);
    brain.deliberations.push({ goal:"g", hypotheses:["h"], ts:Date.now() });
    brain.brainStrict = true; brain.thinkSatisfied = true; brain.consecutiveFailures = 1;
    resetBrain();
    expect(brain.episodes.size).toBe(0);
    expect(brain.deliberations.length).toBe(0);
    expect(brain.brainStrict).toBe(false);
    expect(brain.consecutiveFailures).toBe(0);
  });

  it("latestPlan returns newest and isPlanDone detects completion", () => {
    expect(latestPlan()).toBeNull();
    expect(isPlanDone()).toBe(false);
    const p1: BrainPlan = { id:"p1", goal:"g1", tasks:[{title:"task one long enough",done:false},{title:"task two long enough",done:false},{title:"task three long enough",done:false}], ts: Date.now()-1000 };
    const p2: BrainPlan = { id:"p2", goal:"g2", tasks:[{title:"task one long enough",done:true},{title:"task two long enough",done:true},{title:"task three long enough",done:true}], ts: Date.now() };
    brain.plans.set(p1.id, p1); brain.plans.set(p2.id, p2); brain.cachedLatestPlan = null;
    expect(latestPlan()?.id).toBe("p2");
    expect(isPlanDone()).toBe(true);
    expect(renderPlan(p2)).toContain("[x] Task 1");
  });

  it("renderPlan formats done and pending", () => {
    const p: BrainPlan = { id:"x", goal:"goal", tasks:[{title:"first task long enough",done:true},{title:"second task long enough",done:false}], ts:Date.now() };
    const txt = renderPlan(p);
    expect(txt).toContain("goal");
    expect(txt).toContain("[x] Task 1");
    expect(txt).toContain("[ ] Task 2");
  });
});

describe("ui footer", () => {
  it("footerText shows STRICT vs OFF with space", () => {
    brain.brainStrict = true; expect(footerText()).toBe("🧠 ◉ STRICT");
    brain.brainStrict = false; expect(footerText()).toBe("🧠 ◉ OFF");
    expect(footerText(true)).toBe("🧠 ◉ STRICT");
    expect(footerText(false)).toBe("🧠 ◉ OFF");
  });

  it("syncFooter sets status and emits, clears when off", () => {
    const setStatus = vi.fn(); const emit = vi.fn();
    const pi: any = { _brainStrict:false, events:{emit}, ui:{setStatus} };
    const ctx: any = { ui:{setStatus} };
    brain.brainStrict = true; syncFooter(pi, ctx, true);
    expect(pi._brainStrict).toBe(true);
    expect(setStatus).toHaveBeenCalledWith("brain", "🧠 ◉ STRICT");
    expect(emit).toHaveBeenCalled();
    brain.brainStrict = false; syncFooter(pi, ctx, false);
    expect(setStatus).toHaveBeenCalledWith("brain", "🧠 ◉ OFF");
  });
});

describe("util", () => {
  it("truncate limits lines and bytes", () => {
    const longLines = Array.from({length:2005}, (_,i)=>`line ${i}`).join("\n");
    const t = truncate(longLines);
    expect(t).toContain("[truncated 5 lines]");
    const big = "a".repeat(60000);
    const tb = truncate(big);
    expect(tb).toContain("[truncated to 50KB]");
    expect(tb.length).toBeLessThan(60000);
  });

  it("isNoiseBash detects ls/cat vs real errors", () => {
    expect(isNoiseBash("ls -la", "file1\nfile2")).toBe(true); // short ls
    expect(isNoiseBash("ls -la", "a".repeat(300))).toBe(false); // long ls not noise per <200 rule
    expect(isNoiseBash("git status", "On branch master")).toBe(true);
    expect(isNoiseBash("cat file", "ENOENT: no such file")).toBe(true); // cat short is noise per first rule (output <200)
    expect(isNoiseBash("npm test", "failed")).toBe(false);
    expect(isNoiseBash("", "")).toBe(true);
  });
});

describe("validation edge", () => {
  it("planTaskError rejects empty and short", () => {
    expect(planTaskError([])).toBeDefined();
    expect(planTaskError(["short","short","short"])).toContain("≥10 chars");
  });
});
