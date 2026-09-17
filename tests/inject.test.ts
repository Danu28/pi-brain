import { beforeEach, describe, expect, it } from "vitest";
import { isFollowUpPrompt, registerInjection } from "../src/inject";
import { brain, resetBrain } from "../src/state";

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

function userMsg(text: string): any {
  return { role: "user", content: [{ type: "text", text }] };
}

function textOf(msgs: any[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    return (c ?? []).map((b: any) => b?.text ?? "").join("");
  }
  return "";
}

describe("inject — static flow note appended to user query (KV-cache friendly)", () => {
  let runner: ReturnType<typeof makePi>;
  beforeEach(() => {
    resetBrain();
    runner = makePi();
    registerInjection(runner.pi as any);
  });

  it("appends static [brain:on] note once on new-task turn", async () => {
    (brain as any).brainMode = "on";
    const msgs = [userMsg("explain this project")];
    const res = await runner.fire("context", { messages: msgs });
    const out = res?.messages ?? msgs;
    const t = textOf(out);
    expect(t).toContain("[brain:on]");
    expect(t).toContain("memory always");

    // idempotent: second fire does NOT append again
    const res2 = await runner.fire("context", { messages: out });
    expect(textOf(res2?.messages ?? out).indexOf("[brain:on]")).toBe(textOf(out).indexOf("[brain:on]"));
    expect((res2?.messages ?? out).length).toBe(out.length);
  });

  it("legacy guided mode still appends the on note (normalized)", async () => {
    (brain as any).brainMode = "guided";
    const msgs = [userMsg("refactor the reducer")];
    const out = (await runner.fire("context", { messages: msgs }))?.messages ?? msgs;
    expect(textOf(out)).toContain("[brain:on]");
  });

  it("off mode appends nothing", async () => {
    (brain as any).brainMode = "off";
    const msgs = [userMsg("plain question")];
    const res = await runner.fire("context", { messages: msgs });
    const out = res?.messages ?? msgs;
    expect(textOf(out)).not.toContain("[brain:");
  });

  it("follow-up turns ('go'/'yes') get NO note", async () => {
    (brain as any).brainMode = "on";
    for (const q of ["go", "yes", "continue"]) {
      const msgs = [userMsg(q)];
      const out = (await runner.fire("context", { messages: msgs }))?.messages ?? msgs;
      expect(textOf(out).trim()).toBe(q);
    }
  });

  it("isFollowUpPrompt detects trivial responses", () => {
    expect(isFollowUpPrompt("go")).toBe(true);
    expect(isFollowUpPrompt("continue")).toBe(true);
    expect(isFollowUpPrompt("please fix the bug in hooks.ts")).toBe(false);
    expect(isFollowUpPrompt("")).toBe(true);
  });
});