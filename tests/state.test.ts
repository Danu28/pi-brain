import { describe, expect, it, beforeEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { brain, resetBrain, latestPlan, isPlanDone, renderPlan } from "../src/state";
import { indexEpisode, unindexEpisode, rebuildIndex, pruneExpired, candidatePool } from "../src/recall";
import { footerText, syncFooter } from "../src/ui";
import { readMode, writeMode } from "../src/storage";
import type { BrainEpisode, BrainPlan } from "../src/types";

beforeEach(() => resetBrain());

function ep(p: Partial<BrainEpisode> & { cue:string; summary:string }): BrainEpisode {
  return { id: p.id ?? `${p.cue}:${Date.now()}`, ts: Date.now(), source:"remember", ...p } as BrainEpisode;
}

describe("state", () => {
  it("resetBrain and latestPlan/isPlanDone/renderPlan", () => {
    expect(latestPlan()).toBeNull(); expect(isPlanDone()).toBe(false);
    brain.episodes.set("a", ep({ cue:"a", summary:"s" })); brain.deliberations.push({ goal:"g", hypotheses:["h"], ts:Date.now() });
    brain.brainStrict=true; brain.consecutiveFailures=1;
    resetBrain();
    expect(brain.episodes.size).toBe(0); expect(brain.deliberations.length).toBe(0); expect(brain.brainStrict).toBe(false);
    const p1: BrainPlan = { id:"p1", goal:"g1", tasks:[{title:"task one long enough",done:false},{title:"task two long enough",done:false},{title:"task three long enough",done:false}], ts:Date.now()-1000 };
    const p2: BrainPlan = { id:"p2", goal:"g2", tasks:[{title:"task one long enough",done:true},{title:"task two long enough",done:true},{title:"task three long enough",done:true}], ts:Date.now() };
    brain.plans.set(p1.id,p1); brain.plans.set(p2.id,p2); brain.cachedLatestPlan=null;
    expect(latestPlan()?.id).toBe("p2"); expect(isPlanDone()).toBe(true);
    expect(renderPlan(p2)).toContain("[x] Task 1"); expect(renderPlan(p1)).toContain("[ ] Task 1");
  });
});

describe("recall", () => {
  it("index/unindex/rebuild and candidatePool", () => {
    const e = ep({ cue:"unique-cue-xyz", summary:"hello", tags:["infra"] });
    indexEpisode(e); brain.episodes.set(e.id,e);
    expect(brain.tokenIndex.get("unique")?.has(e.id)).toBe(true);
    expect(candidatePool("unique-cue-xyz").some(x=>x.id===e.id)).toBe(true);
    expect(candidatePool("nomatchzzz").length).toBe(brain.episodes.size);
    unindexEpisode(e); expect(brain.tokenIndex.get("unique")).toBeUndefined();
    brain.episodes.set(e.id,e); rebuildIndex();
    expect(brain.tokenIndex.get("unique")?.has(e.id)).toBe(true);
  });

  it("pruneExpired removes expired and LRU over cap", () => {
    const expired = ep({ id:"exp", cue:"old", summary:"old", ts:Date.now()-10000, expiresAt: Date.now()-1000 } as any);
    brain.episodes.set(expired.id, expired); indexEpisode(expired);
    expect(pruneExpired({} as any)).toBe(1); expect(brain.episodes.has("exp")).toBe(false);
    for(let i=0;i<42;i++){ const e=ep({ id:`a${i}`, cue:`auto${i}`, summary:"x", source:"auto" as any, ts:Date.now()-i*1000 }); brain.episodes.set(e.id,e); indexEpisode(e); }
    expect(pruneExpired({} as any)).toBeGreaterThan(0);
    expect(brain.episodes.size).toBeLessThanOrEqual(40);
  });
});

describe("ui", () => {
  it("footerText and syncFooter", () => {
    brain.brainStrict=true; expect(footerText()).toBe("🧠 ◉ STRICT");
    brain.brainStrict=false; expect(footerText()).toBe("🧠 ◉ OFF");
    const setStatus=vi.fn(), emit=vi.fn();
    const pi:any={ _brainStrict:false, events:{emit}, ui:{setStatus} };
    const ctx:any={ ui:{setStatus} };
    syncFooter(pi,ctx,true); expect(pi._brainStrict).toBe(true); expect(setStatus).toHaveBeenCalledWith("brain","🧠 ◉ STRICT");
    syncFooter(pi,ctx,false); expect(setStatus).toHaveBeenCalledWith("brain","🧠 ◉ OFF");
  });
});

describe("storage", () => {
  it("readMode/writeMode roundtrip", async () => {
    const { readMode, writeMode, MODE_FILE } = await import("../src/storage");
    try { unlinkSync(MODE_FILE); } catch {}
    // initially undefined or previous value cleared
    writeMode(true); expect(readMode()).toBe(true);
    writeMode(false); expect(readMode()).toBe(false);
    try { unlinkSync(MODE_FILE); } catch {}
  });
});
