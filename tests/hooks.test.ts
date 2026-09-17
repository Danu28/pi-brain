import { beforeEach, describe, expect, it } from "vitest";
import { registerHooks } from "../src/hooks";
import { brain, resetBrain } from "../src/state";

// Simulate the pi extension runner: capture hook handlers, call them with fake events.
function makePi() {
  const handlers = new Map<string, (ev: any, ctx: any) => any>();
  const pi: any = {
    on: (ev: string, fn: any) => handlers.set(ev, fn),
    events: { emit: () => {}, },
    registerTool: () => {},
    registerCommand: () => {},
  };
  return {
    pi,
    fire: async (ev: string, payload: any, ctx: any = {}) => handlers.get(ev)?.(payload, ctx),
  };
}

async function fireToolResult(runner: any, toolName: string, isError: boolean, extra: any = {}) {
  return runner.fire("tool_result", { toolName, isError, content: [{ type: "text", text: isError ? "boom" : "ok" }], input: {}, ...extra }, { signal: { aborted: false } });
}

describe("hooks — lean: silent when working, tutor on 2 failures, memory always", () => {
  let runner: ReturnType<typeof makePi>;
  beforeEach(() => {
    resetBrain();
    (brain as any).brainMode = "on";
    runner = makePi();
    registerHooks(runner.pi as any);
  });

  it("CRUX: edit/write/plan are NOT blocked without think+plan (ceremony removed)", async () => {
    brain.thinkSatisfied = false;
    (brain as any).hasPlan = false;
    const e = await runner.fire("tool_call", { toolName: "edit" }, {});
    const w = await runner.fire("tool_call", { toolName: "write" }, {});
    const p = await runner.fire("tool_call", { toolName: "plan" }, {});
    expect(e?.block).toBeFalsy();
    expect(w?.block).toBeFalsy();
    expect(p?.block).toBeFalsy();
  });

  it("off mode = stock pi behavior (no tutor block even with needsDebugThink)", async () => {
    (brain as any).brainMode = "off";
    brain.needsDebugThink = true;
    const r = await runner.fire("tool_call", { toolName: "edit" }, {});
    expect(r?.block).toBeFalsy();
  });

  it("1 failure then success RESETS counter — tutor NOT triggered", async () => {
    await fireToolResult(runner, "bash", true);
    expect((brain as any).failureCount).toBe(1);
    expect(brain.needsDebugThink).toBe(false);
    await fireToolResult(runner, "bash", false);
    expect((brain as any).failureCount).toBe(0);
    expect(brain.needsDebugThink).toBe(false);
  });

  it("2 repeated failures trigger the tutor; write/edit blocked until think{debug}", async () => {
    await fireToolResult(runner, "edit", true);
    await fireToolResult(runner, "edit", true);
    expect((brain as any).failureCount).toBe(2);
    expect(brain.needsDebugThink).toBe(true);
    const blk = await runner.fire("tool_call", { toolName: "edit" }, {});
    expect(blk?.block).toBe(true);
    expect(blk.reason).toContain("think");
    // bash stays FREE while armed — probing/verification is never locked
    const bsh = await runner.fire("tool_call", { toolName: "bash", input: { command: "git status" } }, {});
    expect(bsh?.block).toBeFalsy();
    const w = await runner.fire("tool_call", { toolName: "write" }, {});
    expect(w?.block).toBe(true);
    // debug think success → tutor released
    await fireToolResult(runner, "think", false, { details: { deliberation: { goal: "debug test issue" } } });
    expect((brain as any).failureCount).toBe(0);
    expect(brain.needsDebugThink).toBe(false);
  });

  it("failures separated by ANY success never reach 2 consecutive", async () => {
    await fireToolResult(runner, "bash", true);
    await fireToolResult(runner, "write", false);
    await fireToolResult(runner, "bash", true);
    expect((brain as any).failureCount).toBe(1);
    expect(brain.needsDebugThink).toBe(false);
  });

  it("non-debug think between failures does NOT reset the consecutive counter", async () => {
    await fireToolResult(runner, "bash", true);
    await fireToolResult(runner, "think", false, { details: { deliberation: { goal: "normal planning" } } });
    await fireToolResult(runner, "bash", true);
    expect((brain as any).failureCount).toBe(2);
    expect(brain.needsDebugThink).toBe(true);
  });

  it("rm -rf needs UI confirm; regular bash passes through", async () => {
    const noUi = await runner.fire("tool_call", { toolName: "bash", input: { command: "rm -rf vendor" } }, {});
    expect(noUi?.block).toBe(true);
    const declined = await runner.fire("tool_call", { toolName: "bash", input: { command: "rm -rf vendor" } }, { hasUI: true, ui: { confirm: async () => false } });
    expect(declined?.block).toBe(true);
    const allowed = await runner.fire("tool_call", { toolName: "bash", input: { command: "rm -rf vendor" } }, { hasUI: true, ui: { confirm: async () => true } });
    expect(allowed?.block).toBeFalsy();
    const safe = await runner.fire("tool_call", { toolName: "bash", input: { command: "ls" } }, {});
    expect(safe?.block).toBeFalsy();
  });

  it("tutor blocks several tools in one batch — second block is terse", async () => {
    brain.needsDebugThink = true;
    const first = await runner.fire("tool_call", { toolName: "edit" }, {});
    const second = await runner.fire("tool_call", { toolName: "write" }, {});
    expect(first?.block).toBe(true);
    expect(second?.block).toBe(true);
    expect((first.reason as string).length).toBeGreaterThan((second.reason as string).length);
  });

  it("audit-blocked remember counts as attempted — Rule-5 nudge does not loop", async () => {
    brain.hasWriteEdit = true;
    (brain as any).cachedLatestPlan = { tasks: [{ title: "t", done: true }], ts: Date.now() };
    const n1: string[] = [];
    await runner.fire("turn_end", {}, { ui: { notify: (m: string) => n1.push(m) } });
    expect(n1.length).toBeGreaterThan(0); // first nudge fires
    await fireToolResult(runner, "remember", false, { details: { blocked: true } }); // audit blocked
    expect(brain.hasRemember).toBe(true); // attempted counts as done
    const n2: string[] = [];
    await runner.fire("turn_end", {}, { ui: { notify: (m: string) => n2.push(m) } });
    expect(n2.length).toBe(0); // no nudge loop
  });
});