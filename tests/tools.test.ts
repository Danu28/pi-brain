import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brain, resetBrain } from "../src/state";
import { registerRemember } from "../src/tools/remember";
import { registerRecall } from "../src/tools/recall";
import { registerThink } from "../src/tools/think";
import { registerCreative } from "../src/tools/creative";
import { registerPlan } from "../src/tools/plan";
import { registerHabit } from "../src/tools/habit";
import { registerBrainStatus } from "../src/tools/brain-status";

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

beforeEach(() => { resetBrain(); vi.restoreAllMocks(); });

describe("tools: remember / recall", () => {
  it("remember encodes, upserts exact cue, audits similar", async () => {
    const { pi, tools } = mockPi(); registerRemember(pi); const t = tools["remember"];
    let r = await t.execute("1", { cue:"my-cue", summary:"first summary" }, null as any);
    expect(r.details.audit).toBe("clean");
    const id1 = r.details.id;
    // exact cue upsert (no force) updates same id
    r = await t.execute("2", { cue:"MY-CUE", summary:"updated summary" }, null as any);
    expect(r.details.audit).toBe("exact-cue-upsert"); expect(r.details.id).toBe(id1);
    expect(brain.episodes.get(id1)!.summary).toContain("updated");
    // similar audit: create similar episode, then try similar
    await t.execute("3", { cue:"deploy fix", summary:"ship release deploy" }, null as any);
    const blocked = await t.execute("4", { cue:"ship deploy", summary:"ship release deploy fix" }, null as any);
    expect(blocked.details.blocked).toBe(true);
    const forced = await t.execute("5", { cue:"ship deploy 2", summary:"ship release deploy fix again", force:true }, null as any);
    expect(forced.details.audit).toBe("forced");
  });

  it("recall memo, filters, tag-only and batch", async () => {
    const { pi, tools } = mockPi(); registerRemember(pi); registerRecall(pi);
    const rem = tools["remember"]; const rec = tools["recall"];
    await rem.execute("1", { cue:"cold start", summary:"cold start fix", tags:["infra"] }, null as any);
    await rem.execute("2", { cue:"auth bug", summary:"login fail", tags:["auth"] }, null as any);
    let r = await rec.execute("1", { query:"cold", limit:1 }, null as any);
    expect(r.details.episodes.length).toBe(1);
    // tag-only recall
    r = await rec.execute("2", { query:"", tags:["infra"], limit:5 }, null as any);
    expect(r.details.episodes[0].tags).toContain("infra");
    // batch queries
    r = await rec.execute("3", { queries:["cold","auth"], limit:5 }, null as any);
    expect(r.details.episodes.length).toBeGreaterThan(0);
    // memo hit
    const r2 = await rec.execute("4", { query:"cold", limit:1 }, null as any);
    expect(r2.details.cached).toBe(true);
  });
});

describe("tools: think / creative / plan", () => {
  it("think creates deliberation and guards debug", async () => {
    const { pi, tools } = mockPi(); registerThink(pi);
    const t = tools["think"];
    brain.needsDebugThink = true;
    let r = await t.execute("1", { goal:"fix bug", hypotheses:["a"] }, null as any);
    expect(r.details.error).toBe("debug required");
    r = await t.execute("2", { goal:"debug task 1", hypotheses:["cause long enough","fix long enough"] }, null as any);
    expect(r.details.deliberation.goal).toContain("debug");
    expect(brain.thinkSatisfied).toBe(true);
    expect(brain.deliberations.length).toBe(1);
  });

  it("creative post-think fuse and hint when no think", async () => {
    const { pi, tools } = mockPi(); registerRemember(pi); registerThink(pi); registerCreative(pi);
    const rem = tools["remember"]; const think = tools["think"]; const creative = tools["creative-thinking"];
    // no think yet -> hint
    await rem.execute("1", { cue:"neon", summary:"neon glow" }, null as any);
    let r = await creative.execute("1", { cues:["neon","login"] }, null as any);
    expect(r.details.hint).toBe("missing-think");
    // with think -> fuses
    await think.execute("1", { goal:"design login", hypotheses:["glass morphism long enough","neon border long enough"] }, null as any);
    r = await creative.execute("2", { cues:["neon","login"], prompt:"neon + login" }, null as any);
    expect(r.content[0].text).toContain("neon");
  });

  it("plan creates, validates, updates and resets streak when done", async () => {
    const { pi, tools } = mockPi(); registerThink(pi); registerPlan(pi);
    const plan = tools["plan"];
    // need think before plan (strict) — use hypotheses single-shot
    let r = await plan.execute("1", { goal:"goal", tasks:["a","b"] }, null as any);
    expect(r.details.error).toBeDefined(); // <3 tasks
    r = await plan.execute("2", { goal:"fix", tasks:["task one long enough","task two long enough","task three long enough"], hypotheses:["hyp1 long enough","hyp2 long enough"] }, null as any);
    expect(r.details.plan.goal).toBe("fix");
    const id = r.details.plan.id;
    expect(brain.thinkSatisfied).toBe(true);
    // update done
    brain.consecutiveFailures = 1;
    r = await plan.execute("3", { id, done:[0,1,2] }, null as any);
    expect(r.details.plan.tasks.every((t:any)=>t.done)).toBe(true);
    expect(brain.consecutiveFailures).toBe(0); // reset on done
    // validation on update: try to add short tasks
    const r2 = await plan.execute("4", { id, tasks:["short"] }, null as any);
    expect(r2.details.error).toBeDefined();
  });
});

describe("tools: habit / brain-status", () => {
  it("habit scaffolds, previews, and validates", async () => {
    const dir = mkdtempSync(join(tmpdir(),"habit-test-"));
    const { pi, tools } = mockPi(); pi.cwd = dir; registerHabit(pi);
    const h = tools["habit"];
    let r = await h.execute("1", { name:"bad name", when:"", steps:"" }, null as any, null, { cwd:dir, isProjectTrusted:()=>true });
    // empty steps guard
    expect(r.details.error).toBeDefined();
    r = await h.execute("2", { name:"my-habit", when:"when to use", steps:"step1\nstep2" }, null as any, null, { cwd:dir, isProjectTrusted:()=>true });
    expect(r.content[0].text).toContain("Drafted");
    expect(existsSync(join(dir,".pi/skills/brain-my-habit/SKILL.md"))).toBe(true);
    // preview when exists
    r = await h.execute("3", { name:"my-habit", when:"when", steps:"other" }, null as any, null, { cwd:dir, isProjectTrusted:()=>true });
    expect(r.details.blocked).toBe(true);
    // untrusted
    r = await h.execute("4", { name:"other", when:"w", steps:"s" }, null as any, null, { cwd:dir, isProjectTrusted:()=>false });
    expect(r.details.error).toBe("untrusted");
    rmSync(dir, { recursive:true, force:true });
  });

  it("brain-status reports counts and overload", async () => {
    const { pi, tools } = mockPi(); registerRemember(pi); registerBrainStatus(pi);
    const rem = tools["remember"]; const status = tools["brain-status"];
    await rem.execute("1", { cue:"a", summary:"s" }, null as any);
    const r = await status.execute("1", {}, null as any, null, { getContextUsage:()=>({ used:10, total:100, percent:10 }) } as any);
    expect(r.content[0].text).toContain("Episodes: 1");
    expect(r.details.episodes).toBe(1);
    // overload when many
    for(let i=0;i<55;i++) brain.episodes.set(`id${i}`, { id:`id${i}`, cue:`c${i}`, summary:"s", ts:Date.now(), source:"remember" } as any);
    const r2 = await status.execute("2", {}, null as any, null, { getContextUsage:()=>({ percent:90 }) } as any);
    expect(r2.details.overloaded).toBe(true);
  });
});

describe("integration: hooks / inject / command", () => {
  it("hooks 2-strike and off gating", async () => {
    const { registerHooks } = await import("../src/hooks");
    const handlers:any = {};
    const pi:any = { on:(e:string,fn:any)=>handlers[e]=fn, events:{emit:vi.fn()}, appendEntry:vi.fn(async()=>{}), ui:{setStatus:vi.fn()} };
    registerHooks(pi);
    // off → brain tools blocked
    brain.brainStrict=false;
    let res = await handlers["tool_call"]({ toolName:"remember", input:{} }, { hasUI:true, ui:{confirm:vi.fn()} });
    expect(res?.block).toBe(true);
    // on + think required
    brain.brainStrict=true; brain.thinkSatisfied=false;
    res = await handlers["tool_call"]({ toolName:"write", input:{path:"a"} }, { hasUI:true, ui:{confirm:vi.fn()} });
    expect(res?.block).toBe(true);
    brain.thinkSatisfied=true; brain.consecutiveFailures=0;
    const plan = { id:"p", goal:"g", tasks:[{title:"t1 long enough",done:false},{title:"t2 long enough",done:false},{title:"t3 long enough",done:false}], ts:Date.now() } as any;
    brain.plans.set(plan.id, plan); brain.cachedLatestPlan=plan;
    // first failure → 1/2 warn
    let out = await handlers["tool_result"]({ toolName:"bash", isError:true, content:[{type:"text",text:"error"}], input:{command:"fail"} }, { ui:{notify:vi.fn()} });
    expect(out?.content[0].text).toContain("1/2"); expect(brain.consecutiveFailures).toBe(1);
    out = await handlers["tool_result"]({ toolName:"bash", isError:true, content:[{type:"text",text:"error"}], input:{command:"fail"} }, { ui:{notify:vi.fn()} });
    expect(brain.needsDebugThink).toBe(true);
  });

  it("command toggles mode and footer", async () => {
    const { registerCommand } = await import("../src/command");
    const pi:any = { registerCommand:vi.fn((name,def)=>{ pi._def=def; }), appendEntry:vi.fn(async()=>{}), events:{emit:vi.fn()}, _brainStrict:false };
    registerCommand(pi);
    const def = pi._def;
    const ctx:any = { ui:{ notify:vi.fn(), setStatus:vi.fn() } };
    await def.handler("on", ctx); expect(brain.brainStrict).toBe(true);
    await def.handler("off", ctx); expect(brain.brainStrict).toBe(false);
    await def.handler("status", ctx); expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("inject off returns nothing, strict injects", async () => {
    const { registerInjection } = await import("../src/inject");
    const handlers:any={}; const pi:any={ on:(e:string,fn:any)=>handlers[e]=fn, events:{emit:vi.fn()} };
    registerInjection(pi);
    brain.brainStrict=false; let r = await handlers["before_agent_start"]({ prompt:"test" }, {});
    expect(r).toBeUndefined();
    brain.brainStrict=true; brain.episodes.set("e1", { id:"e1", cue:"test", summary:"test summary", ts:Date.now(), source:"remember" } as any);
    const { indexEpisode } = await import("../src/recall"); indexEpisode(brain.episodes.get("e1")!);
    r = await handlers["before_agent_start"]({ prompt:"test" }, {});
    expect(r?.systemPrompt).toContain("STRICT BRAIN MODE");
  });
});
