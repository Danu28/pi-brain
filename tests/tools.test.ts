// Tool-level contract tests for pi-brain (regressions + core behavior).
// Covers remember/recall/think/plan/habit/brain-status/command — previously untested (only scoring/hooks/inject were).
// Sandboxed: vitest.config.ts sets PI_CODING_AGENT_DIR to a temp dir so mode-file writes never touch the real ~/.pi/agent.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCommand } from "../src/command";
import { registerHooks } from "../src/hooks";
import { registerInjection } from "../src/inject";
import { registerSessionHandlers } from "../src/session";
import { brain, resetBrain } from "../src/state";
import { registerTools } from "../src/tools";

const SANDBOX = process.env.PI_CODING_AGENT_DIR!;

function makePi() {
  const handlers = new Map<string, (ev: any, ctx: any) => any>();
  const entries: any[] = [];
  const events: any[] = [];
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi: any = {
    on: (ev: string, fn: any) => handlers.set(ev, fn),
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (n: string, c: any) => commands.set(n, c),
    events: { emit: (name: string, data: any) => events.push({ name, data }) },
    appendEntry: async (type: string, data: any) => { entries.push({ type, data }); },
    cwd: join(SANDBOX, "proj"),
    withFileMutationQueue: async (_f: string, fn: () => void) => fn(),
    sessionManager: null,
  };
  const fire = async (ev: string, payload: any, ctx: any = {}) => handlers.get(ev)?.(payload, ctx ?? pi);
  const run = async (name: string, params: any, ctx: any = pi) => {
    const t = tools.get(name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t.execute("id", params, { aborted: false }, () => {}, ctx);
  };
  const count = (type: string) => entries.filter((e) => e.type === type).length;
  return { pi, handlers, entries, events, tools, commands, fire, run, count };
}

beforeEach(() => {
  resetBrain();
  (brain as any).brainMode = "off";
  brain.brainStrict = false;
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(SANDBOX, "proj", ".pi"), { recursive: true });
});
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const ep1 = { cue: "fix-login-timeout", summary: "Auth login takes 4s over flaky VPN — root cause DNS resolver order, fixed resolv.conf", tags: ["auth", "net"], refs: ["src/auth.ts"] };
const ep2 = { cue: "auth-token-expiry", summary: "JWT expiry causes 401 on refresh — store refresh token in httpOnly cookie", tags: ["auth", "security"] };
const ep3 = { cue: "docker-image-size", summary: "CI image 2GB — switching to alpine base cut to 210MB", tags: ["ci", "build"] };
const ep4 = { cue: "prometheus-scrape", summary: "added prometheus scrape endpoint with histogram buckets", tags: ["observability", "infra"] };

describe("remember", () => {
  it("encodes a new episode with relevance + index", async () => {
    const h = makePi(); registerTools(h.pi);
    const r = await h.run("remember", ep1);
    expect(r.details?.id).toBeTruthy();
    expect(/:[0-9]+:[a-z0-9]{6}$/.test(r.details.episode.id)).toBe(true);
    expect(brain.episodes.size).toBe(1);
    expect(typeof r.details.episode.relevance).toBe("number");
    expect(brain.tokenIndex.size).toBeGreaterThan(0);
  });

  it("QDS Delete: low-relevance trivia is blocked", async () => {
    const h = makePi(); registerTools(h.pi);
    const r = await h.run("remember", { cue: "tmp", summary: "todo" });
    expect(r.details?.blocked).toBe(true);
    expect(brain.episodes.size).toBe(0);
  });

  it("similar-episode audit blocks unless force", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", ep1);
    const blocked = await h.run("remember", { cue: "another-login-fix", summary: "login timeout caused by DNS resolution order on flaky network" });
    expect(blocked.details?.blocked).toBe(true);
    expect(blocked.details?.audit).toBe("similar-found");
    expect(brain.episodes.size).toBe(1);
    const forced = await h.run("remember", { cue: "another-login-fix", summary: "login timeout caused by DNS resolution order on flaky network", force: true });
    expect(forced.details?.audit).toBe("forced");
    expect(brain.episodes.size).toBe(2);
  });

  it("exact cue upserts (no duplicate), resets relevance + expiresAt", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", { ...ep1, expiresAt: Date.now() + 1000 } as any);
    const before = brain.episodes.values().next().value;
    (before as any).expiresAt = Date.now() - 1;
    const r = await h.run("remember", { ...ep1, summary: "UPDATED: DNS fix replaced by systemd-resolved stub" });
    expect(r.details?.audit).toBe("exact-cue-upsert");
    expect(brain.episodes.size).toBe(1);
    expect(h.count("brain:episode")).toBe(2); // original entry + upsert entry (no new id)
    const ep: any = brain.episodes.values().next().value;
    expect(ep.summary).toContain("systemd-resolved");
    expect(ep.expiresAt).toBeUndefined();
  });
});

describe("recall", () => {
  it("ranks the relevant episode first and hides noise <5.0", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", ep2); await h.run("remember", ep3); await h.run("remember", ep4);
    const r: any = await h.run("recall", { query: "auth token refresh", limit: 5 });
    expect(r.content[0].text.startsWith("[auth-token-expiry]")).toBe(true);
    expect(r.content[0].text).not.toContain("docker-image-size");
  });

  it("memoizes identical queries within TTL", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", ep2);
    const r1: any = await h.run("recall", { query: "auth", limit: 5 });
    const r2: any = await h.run("recall", { query: "auth", limit: 5 });
    expect(r2.details?.cached).toBe(true);
    expect(r1.content[0].text).toBe(r2.content[0].text);
  });

  it("supports tag-only recall and since/batch filters", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", ep2); await h.run("remember", ep3); await h.run("remember", ep4);
    const tagOnly: any = await h.run("recall", { query: "", tags: ["ci"] });
    expect(tagOnly.content[0].text).toContain("docker-image-size");
    // since:0h boundary is Date.now() at recall — wait 5ms so freshly-remembered episodes (same-ms ts) are strictly older
    await new Promise((r) => setTimeout(r, 5));
    const since: any = await h.run("recall", { query: "auth", since: "0h" });
    expect(since.details?.episodes?.length ?? 0).toBe(0);
    const batch: any = await h.run("recall", { queries: ["auth", "prometheus"], limit: 3 });
    expect(batch.content[0].text).toContain("auth-token-expiry");
    expect(batch.content[0].text).toContain("prometheus-scrape");
  });

  it("REGRESSION: time-travel replay works with verbatim think id (no double-prefix)", async () => {
    const h = makePi(); registerTools(h.pi);
    const t: any = await h.run("think", { goal: "Should we migrate to pnpm?", hypotheses: ["Side A | cost:6 risk:4 rev:9 | Faster installs, migration effort", "Side B | cost:2 risk:7 rev:5 | npm workspaces fine, migrate later"] });
    const id = t.details.deliberation.id;
    expect(id.startsWith("think:")).toBe(true);
    const r: any = await h.run("recall", { query: id }); // verbatim id, as brain-status instructs
    expect(r.details?.replay).toBe(true);
    expect(r.details?.deliberation?.id).toBe(id);
    const r2: any = await h.run("recall", { query: `think:${id}` }); // prefixed convention also works
    expect(r2.details?.replay).toBe(true);
  });

  it("REGRESSION: plan replay works with verbatim brain-plan id", async () => {
    const h = makePi(); registerTools(h.pi);
    const p: any = await h.run("plan", { goal: "replay probe", tasks: ["probe task one detailed enough", "probe task two detailed enough", "probe task three detailed enough"] });
    const id = p.details.plan.id;
    expect(id.startsWith("brain-plan:")).toBe(true);
    const r: any = await h.run("recall", { query: id });
    expect(r.details?.replay).toBe(true);
    expect(r.details?.plan?.id).toBe(id);
  });
});

describe("think", () => {
  it("runs a rubric debate and pins a winner", async () => {
    const h = makePi(); registerTools(h.pi);
    const t: any = await h.run("think", { goal: "pnpm migration?", hypotheses: ["Side A | cost:6 risk:4 rev:9 | Faster installs, migration effort", "Side B | cost:2 risk:7 rev:5 | npm workspaces fine"] });
    expect(t.details?.debate?.winner).toBeTruthy();
    expect(t.details?.debate?.rubric?.a?.avg).toBeGreaterThan(0);
    expect(brain.deliberations.length).toBe(1);
  });

  it("debug gate: blocks non-debug think when 2 failures pending, allows debug", async () => {
    const h = makePi(); registerTools(h.pi);
    brain.needsDebugThink = true;
    expect((await h.run("think", { goal: "unrelated plan", hypotheses: ["x"] })).details?.error).toBe("debug required");
    const ok: any = await h.run("think", { goal: "debug Task 2", hypotheses: ["cause: schema mismatch", "fix: migration"] });
    expect(ok.details?.deliberation?.goal).toBe("debug Task 2");
    expect(brain.needsDebugThink).toBe(false);
  });
});

describe("plan", () => {
  const valid = ["analyze auth requirement & existing routes | refs:src/routes.ts", "design token schema + decide storage | refs:src/token.ts risk:3", "implement login endpoint", "verify with tests and bash"];

  it("creates a plan with 3-10 tasks and sets hasPlan", async () => {
    const h = makePi(); registerTools(h.pi);
    const p: any = await h.run("plan", { goal: "add auth flow", tasks: valid });
    expect(p.details?.plan?.id).toBeTruthy();
    expect(brain.hasPlan).toBe(true);
    expect(h.count("brain:plan")).toBe(1);
  });

  it("rejects <3 tasks with actionable error", async () => {
    const h = makePi(); registerTools(h.pi);
    const r: any = await h.run("plan", { goal: "x", tasks: ["two-ish tasks only", "second one"] });
    expect(r.details?.error).toBe("invalid tasks");
    expect(brain.hasPlan).toBe(false);
  });

  it("enforces verifiable DAG: dependent waits for deps", async () => {
    const h = makePi(); registerTools(h.pi);
    const p: any = await h.run("plan", { goal: "ship feature", tasks: ["task one base step", "task two depends one | depends:0", "task three depends both | depends:0,1"] });
    const id = p.details.plan.id;
    expect((await h.run("plan", { id, done: [2] })).details?.error).toBe("depends not satisfied");
    expect((await h.run("plan", { id, done: [1] })).details?.error).toBe("depends not satisfied"); // task two waits for task one
    await h.run("plan", { id, done: [0] });
    expect((await h.run("plan", { id, done: [1] })).details?.error).toBeUndefined();
    const d3: any = await h.run("plan", { id, done: [2] });
    expect(d3.details?.error).toBeUndefined();
    expect(d3.content[0].text).toContain("[x] Task 3");
  });

  it("REGRESSION: rejects self-ref / out-of-range depends at create", async () => {
    const h = makePi(); registerTools(h.pi);
    const selfRef: any = await h.run("plan", { goal: "g", tasks: ["task a base step", "task b self dep | depends:1", "task c independent step"] });
    expect(selfRef.details?.error).toBe("invalid depends");
    expect(brain.plans.size).toBe(0);
    const oob: any = await h.run("plan", { goal: "g", tasks: ["task a base step", "task b fine", "task c depends on 9 | depends:9"] });
    expect(oob.details?.error).toBe("invalid depends");
    expect(brain.plans.size).toBe(0);
  });

  it("REGRESSION: rejects self-ref depends at append", async () => {
    const h = makePi(); registerTools(h.pi);
    const p: any = await h.run("plan", { goal: "g", tasks: ["task a base step", "task b base step", "task c base step"] });
    const id = p.details.plan.id;
    const bad: any = await h.run("plan", { id, tasks: ["task d self dep | depends:3"] });
    expect(bad.details?.error).toBe("invalid depends");
    expect(p.details.plan.tasks.length).toBe(3); // unchanged (append rejected)
    const ok: any = await h.run("plan", { id, tasks: ["task d fine | depends:0"] });
    expect(ok.details?.plan?.tasks.length).toBe(4);
  });

  it("appends extra tasks via chunking hint", async () => {
    const h = makePi(); registerTools(h.pi);
    const p: any = await h.run("plan", { goal: "g", tasks: ["task a base step", "task b base step", "task c base step"] });
    const more: any = await h.run("plan", { id: p.details.plan.id, tasks: ["task d added step", "task e added step", "task f added step"] });
    expect(more.details.plan.tasks.length).toBe(6);
  });
});

describe("habit", () => {
  it("drafts a sanitized SKILL.md, previews before overwrite, honors force", async () => {
    const h = makePi(); registerTools(h.pi);
    const r: any = await h.run("habit", { name: "test-habit", when: "when login timer fails | repeat fix", steps: "1) check DNS\n2) fix resolv.conf" });
    const dir = r.details?.skillPath;
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    const txt = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(txt).toContain("name: brain-test-habit");
    expect(txt).toContain("description: when login timer fails | repeat fix");
    const preview: any = await h.run("habit", { name: "test-habit", when: "w", steps: "s" });
    expect(preview.details?.blocked).toBe(true);
    const forced: any = await h.run("habit", { name: "test-habit", when: "w", steps: "s", force: true });
    expect(forced.details?.blocked).toBeFalsy();
  });

  it("blocks untrusted projects and sanitizes path traversal names", async () => {
    const h = makePi(); registerTools(h.pi);
    h.pi.isProjectTrusted = () => false;
    expect((await h.run("habit", { name: "untrusted-h", when: "w", steps: "s" })).details?.error).toBe("untrusted");
    h.pi.isProjectTrusted = () => true;
    const evil: any = await h.run("habit", { name: "../evil", when: "x", steps: "y" });
    expect(String(evil.details?.skillPath ?? "")).not.toContain("..");
  });
});

describe("brain-status", () => {
  it("reports episodes + graph and emits overload >80%", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", { ...ep1, force: true });
    const bs: any = await h.run("brain-status", {});
    expect(/Episodes: 1/.test(bs.content[0].text)).toBe(true);
    expect(bs.content[0].text).toContain("Graph:");
    h.pi.getContextUsage = () => ({ tokens: 9000, contextWindow: 10000, percent: 90 });
    await h.run("brain-status", {});
    expect(h.events.some((e) => e.name === "brain:overload")).toBe(true);
  });
});

describe("command + session + inject wiring", () => {
  it("/pi-brain on|guided|off persists mode to sandboxed file + brain:mode entry", async () => {
    const h = makePi(); registerCommand(h.pi);
    const msgs: string[] = [];
    const notify = (m: string) => msgs.push(m);
    await h.commands.get("pi-brain").handler("status", { ui: { notify } });
    expect(msgs[0]).toContain("pi-brain:");
    await h.commands.get("pi-brain").handler("on", { ui: { notify } });
    expect(brain.brainMode).toBe("strict");
    expect(brain.brainStrict).toBe(true);
    await h.commands.get("pi-brain").handler("guided", { ui: { notify } });
    expect(brain.brainMode).toBe("guided");
    expect(existsSync(join(SANDBOX, "pi-brain.json"))).toBe(true); // sandboxed — never ~/.pi/agent
    await h.commands.get("pi-brain").handler("off", { ui: { notify } });
    expect(brain.brainMode).toBe("off");
    await h.commands.get("pi-brain").handler("bogus", { ui: { notify } });
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });

  it("session_start rebuilds episodes/plans/mode from branch and rebuilds index", async () => {
    const h = makePi(); registerSessionHandlers(h.pi);
    h.pi.sessionManager = { getBranch: () => [
      { type: "custom", customType: "brain:episode", data: { id: "e1", cue: "branch-ep", summary: "episode from branch", ts: 2, source: "remember" } },
      { type: "custom", customType: "brain:plan", data: { id: "pl1", goal: "g", tasks: [{ title: "t", done: true }], ts: 2 } },
      { type: "custom", customType: "brain:mode", data: { mode: "guided", enabled: false, ts: 2 } },
    ] };
    await h.fire("session_start", {}, { sessionManager: h.pi.sessionManager, ui: {} });
    expect(brain.episodes.has("e1")).toBe(true);
    expect(brain.plans.has("pl1")).toBe(true);
    expect(brain.tokenIndex.size).toBeGreaterThan(0);
    // file wins over branch: no pi-brain.json in sandbox → branch mode applies
    expect((brain as any).brainMode).toBe("guided");
  });

  it("session_tree re-derives state for the new branch (todo.ts pattern)", async () => {
    const h = makePi(); registerSessionHandlers(h.pi);
    h.pi.sessionManager = { getBranch: () => [
      { type: "custom", customType: "brain:episode", data: { id: "t1", cue: "tree-ep", summary: "episode on this branch", ts: 3, source: "remember" } },
    ] };
    await h.fire("session_tree", {}, { sessionManager: h.pi.sessionManager, ui: {} });
    expect(brain.episodes.has("t1")).toBe(true);
  });

  it("sidecar memory store survives resetBranch (compaction-safe persistence)", async () => {
    const h = makePi(); registerTools(h.pi);
    await h.run("remember", { cue: "durable-fix", summary: "episode persisted to sidecar memory file", tags: ["store"], force: true });
    const before = brain.episodes.size;
    expect(before).toBeGreaterThan(0);
    resetBrain(); // simulates fork/resume/compact boundary
    expect(brain.episodes.size).toBe(0);
    await import("../src/state").then(({ loadMemory }) => loadMemory());
    expect(brain.episodes.size).toBe(before);
    expect([...brain.episodes.values()].some((e: any) => e.cue === "durable-fix")).toBe(true);
  });

  it("context inject appends the static note once and skips follow-ups", async () => {
    const h = makePi(); registerInjection(h.pi); registerHooks(h.pi);
    brain.brainMode = "strict";
    const msgs = [{ role: "user", content: [{ type: "text", text: "explain this project" }] }];
    const out = (await h.fire("context", { messages: msgs }))?.messages ?? msgs;
    const txt = (m: any) => [...m].reverse().find((x: any) => x.role === "user")?.content?.map((b: any) => b?.text ?? "").join("") ?? "";
    expect(txt(out)).toContain("[brain:strict]");
    const out2 = (await h.fire("context", { messages: out }))?.messages ?? out;
    expect((txt(out2).match(/\[brain:strict\]/g) || []).length).toBe(1);
    const fu = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const out3 = (await h.fire("context", { messages: fu }))?.messages ?? fu;
    expect(txt(out3)).toBe("go");
  });

  it("compaction injects compressed episodes with the documented result shape", async () => {
    const h = makePi(); registerTools(h.pi); registerSessionHandlers(h.pi);
    await h.run("remember", { cue: "compact-a", summary: "first compacted episode about cache invalidation", force: true });
    await h.run("remember", { cue: "compact-b", summary: "second compacted episode about db migrations", force: true });
    await h.run("remember", { cue: "compact-c", summary: "third compacted episode about ui theming", force: true });
    const comp: any = await h.fire("session_before_compact", { summary: "ctx", preparation: { firstKeptEntryId: "keep-1", tokensBefore: 1234 } }, {});
    expect(comp?.compaction?.summary).toContain("Brain episodes:");
    expect(comp.compaction.summary.length).toBeLessThan(1500);
    expect(comp.compaction.firstKeptEntryId).toBe("keep-1");
    expect(comp.compaction.tokensBefore).toBe(1234);
  });
});