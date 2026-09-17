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

describe("hooks — 2 CONSECUTIVE failures trigger think (not 2 total)", () => {
  let runner: ReturnType<typeof makePi>;
  beforeEach(() => {
    resetBrain();
    (brain as any).brainMode = "strict";
    brain.brainStrict = true;
    runner = makePi();
    registerHooks(runner.pi as any);
  });

  it("1 failure then success RESETS counter — think NOT triggered", async () => {
    await fireToolResult(runner, "bash", true);   // failure 1/2
    expect((brain as any).failureCount).toBe(1);
    expect(brain.needsDebugThink).toBe(false);

    await fireToolResult(runner, "bash", false);  // success → reset
    expect((brain as any).failureCount).toBe(0);
    expect(brain.needsDebugThink).toBe(false);

    await fireToolResult(runner, "edit", true);   // failure 1/2 again
    expect((brain as any).failureCount).toBe(1);
    expect(brain.needsDebugThink).toBe(false);    // still only 1 consecutive
  });

  it("2 repeated failures trigger think; strict blocks retry until think{debug}", async () => {
    await fireToolResult(runner, "edit", true);   // 1
    expect((brain as any).failureCount).toBe(1);
    await fireToolResult(runner, "edit", true);   // 2 consecutive → needsDebugThink
    expect((brain as any).failureCount).toBe(2);
    expect(brain.needsDebugThink).toBe(true);

    // retry without debug think is blocked in strict mode
    const blk = await runner.fire("tool_call", { toolName: "edit" }, {});
    expect(blk?.block).toBe(true);

    // debug think success → counter cleared, block released
    await fireToolResult(runner, "think", false, { details: { deliberation: { goal: "debug test issue" } } });
    expect((brain as any).failureCount).toBe(0);
    expect(brain.needsDebugThink).toBe(false);
  });

  it("failures separated by ANY success never reach 2 consecutive", async () => {
    await fireToolResult(runner, "bash", true);
    await fireToolResult(runner, "write", false); // success in between
    await fireToolResult(runner, "bash", true);   // still 1 → not 2 total
    expect((brain as any).failureCount).toBe(1);
    expect(brain.needsDebugThink).toBe(false);
  });

  it("non-debug think between failures does NOT reset consecutive counter", async () => {
    await fireToolResult(runner, "bash", true);   // 1
    await fireToolResult(runner, "think", false, { details: { deliberation: { goal: "normal planning" } } });
    await fireToolResult(runner, "bash", true);   // still consecutive → 2 → trigger
    expect((brain as any).failureCount).toBe(2);
    expect(brain.needsDebugThink).toBe(true);
  });

  it("strict: recall is OPTIONAL (no block if missed), think+plan mandatory", async () => {
    // no recall ever happened — edit must NOT be blocked for missing recall once think+plan done
    brain.thinkSatisfied = true;
    (brain as any).hasPlan = true;
    const r = await runner.fire("tool_call", { toolName: "edit" }, {});
    expect(r?.block).toBeFalsy();
  });

  it("strict: blocks edit after think but BEFORE plan", async () => {
    brain.thinkSatisfied = true;
    (brain as any).hasPlan = false;
    const r = await runner.fire("tool_call", { toolName: "edit" }, {});
    expect(r?.block).toBe(true);
    expect(r.reason).toContain("plan");
  });

  it("strict: blocks edit before think", async () => {
    brain.thinkSatisfied = false;
    const r = await runner.fire("tool_call", { toolName: "edit" }, {});
    expect(r?.block).toBe(true);
    expect(r.reason).toContain("think");
  });
});