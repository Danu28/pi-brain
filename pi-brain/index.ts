import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore - typebox resolved by pi runtime
import { Type } from "typebox";
// @ts-ignore - tui resolved by pi runtime
import { Text } from "@earendil-works/pi-tui";

// pi-brain — human brain → pi extension
// 5-step: Question→Delete→Simplify→Accelerate→Automate
// One factory, one closure, one Map — no class/DI (T01 gate: no SNN/vector DB/BCI/daemon)

type Episode = {
  id: string;
  cue: string;
  summary: string;
  detail?: string;
  ts: number;
  source: string;
};

type Plan = {
  id: string;
  goal: string;
  tasks: { title: string; done: boolean }[];
  ts: number;
};

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

function truncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n") + `\n[truncated ${lines.length - MAX_LINES} lines]`;
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    // ponytail: naive byte cut, full output parked via writeTempFile if pi provides it — keep simple
    text = Buffer.from(text, "utf8").slice(0, MAX_BYTES).toString("utf8") + "\n[truncated to 50KB]";
  }
  return text;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreEpisode(e: Episode, query: string): number {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  // TF-IDF lite: per-term TF weighted by field (cue 2, summary 1, detail 0.5) + exact phrase bonus
  const qLower = query.toLowerCase();
  let s = 0;
  const cueL = e.cue.toLowerCase();
  const sumL = e.summary.toLowerCase();
  const detL = (e.detail ?? "").toLowerCase();
  // exact phrase bonus (rare but strong signal)
  if (cueL.includes(qLower)) s += 2;
  if (sumL.includes(qLower)) s += 1;
  // per-term TF
  for (const t of terms) {
    const cueCount = cueL.split(t).length - 1;
    const sumCount = sumL.split(t).length - 1;
    const detCount = detL.split(t).length - 1;
    s += cueCount * 2 + sumCount * 1 + detCount * 0.5;
  }
  // ponytail: O(n) scan, add index if >10k entries
  return s;
}

export default function (pi: ExtensionAPI) {
  // hippocampus — durable, branch-scoped
  const episodes = new Map<string, Episode>();
  // PFC scratchpad — deliberations (not durable, per-turn working memory)
  const deliberations: { goal: string; hypotheses: string[]; ts: number }[] = [];
  // /pi-brain strict gate — branch-durable, defaults off
  let brainStrict = false;
  // strict workflow enforcement (per-agent run)
  let thinkSatisfied = false;
  let hasWriteEdit = false;
  let hasRemember = false;
  let agentStartTs = 0;
  let needsDebugThink = false; // unhappy path: failure → must think before retry
  let needsPlanUpdate = false; // after debug think, must update plan before retry
  let cachedLatestPlan: Plan | null = null;
  // plan — ordered tasklist after think (ponytail: one Map, no class)
  const plans = new Map<string, Plan>();
  const renderPlan = (p: Plan) => `${p.goal}\n` + p.tasks.map((t, i) => `${t.done ? "[x]" : "[ ]"} Task ${i + 1}: ${t.title}`).join("\n");

  // T03: TUI renderer for brain:episode — collapsed cue, expanded detail (not in LLM context)
  try {
    (pi as any).registerEntryRenderer?.("brain:episode", (entry: any, opts: any, theme: any) => {
      const d: Episode = entry.data ?? entry;
      const line = opts?.expanded ? `${d.cue}\n${d.summary}${d.detail ? "\n" + d.detail : ""}` : `${d.cue}: ${d.summary.slice(0, 80)}`;
      try { return new (Text as any)(line); } catch { try { return new (Text as any)(String(line), 0, 0); } catch { return new (Text as any)(String(line)); } }
    });
  } catch {}
  try {
    (pi as any).registerEntryRenderer?.("brain:plan", (entry: any, opts: any) => {
      const d: Plan = entry.data ?? entry;
      const line = opts?.expanded ? renderPlan(d) : `${d.goal}: ${d.tasks.filter((t: any)=>t.done).length}/${d.tasks.length} done`;
      try { return new (Text as any)(line); } catch { try { return new (Text as any)(String(line), 0, 0); } catch { return new (Text as any)(String(line)); } }
    });
  } catch {}

  // T04: waking recall — rebuild from branch (branch-safe, like waking)
  pi.on("session_start" as any, async (_ev: any, ctx: any) => {
    episodes.clear();
    plans.clear();
    deliberations.length = 0;
    brainStrict = false;
    thinkSatisfied = false;
    hasWriteEdit = false;
    hasRemember = false;
    needsDebugThink = false;
    needsPlanUpdate = false;
    cachedLatestPlan = null;
    agentStartTs = 0;
    try {
      const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
      let lastMode: boolean | undefined;
      for (const e of branch) {
        if (e.type === "entry" && (e.entryType === "brain:episode" || e.entry_type === "brain:episode")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.id) episodes.set(d.id, d as Episode);
        }
        if (e.type === "entry" && (e.entryType === "brain:plan" || e.entry_type === "brain:plan")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (d?.id && Array.isArray(d.tasks)) plans.set(d.id, d as Plan);
        }
        if (e.type === "entry" && (e.entryType === "brain:mode" || e.entry_type === "brain:mode")) {
          const d = (e as any).data ?? (e as any).entry ?? e;
          if (typeof d?.enabled === "boolean") lastMode = d.enabled;
        }
        if (e.type === "message" && (e as any).message?.role === "toolResult" && (e as any).message?.toolName === "remember") {
          const ep = (e as any).message?.details?.episode;
          if (ep?.id) episodes.set(ep.id, ep);
        }
      }
      if (lastMode !== undefined) brainStrict = lastMode;
    } catch {}
    // reflect in footer
    try { (pi as any)._brainStrict = brainStrict; } catch {}
  });

  // T05: remember — explicit encoding
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Explicitly encode an episode to brain memory (hippocampus). Use cue as associative key.",
    parameters: Type.Object({
      cue: Type.String({ description: "Associative cue (short key for recall)" }),
      summary: Type.String({ description: "One-line summary of episode" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const ep: Episode = {
        id: `${params.cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        cue: truncate(params.cue),
        summary: truncate(params.summary),
        detail: params.detail ? truncate(params.detail) : undefined,
        ts: Date.now(),
        source: "remember",
      };
      await (pi as any).appendEntry?.("brain:episode", ep);
      episodes.set(ep.id, ep);
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id}` }], details: { id: ep.id, episode: ep } };
    },
  });

  // T06: recall — TF-IDF pattern completion (ponytail: O(n) scan, index if >10k)
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Associative recall: TF-IDF cue→ranked episodes (pattern completion). No vector DB, lazy scan over session.",
    parameters: Type.Object({
      query: Type.String({ description: "Cue to recall by" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, signal) {
      const limit = params.limit ?? 5;
      // ponytail: O(n) scan, add index if >10k entries
      const all = [...episodes.values()];
      const scored = all
        .map((e) => ({ e, s: scoreEpisode(e, params.query) }))
        .filter((x) => x.s > 0 || params.query.trim() === "")
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, limit)
        .map((x) => x.e);

      const ranked = scored.length ? scored : all.sort((a, b) => b.ts - a.ts).slice(0, limit);
      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;

      const text = ranked.length
        ? ranked.map((e) => `[${e.cue}] ${e.summary}${e.detail ? " — " + e.detail.slice(0, 120) : ""}`).join("\n")
        : "No episodes yet. Use remember to encode.";
      return { content: [{ type: "text", text: truncate(text) }], details: { episodes: ranked } };
    },
  });

  // T07: brain_status — metacognition + overload signal
  pi.registerTool({
    name: "brain_status",
    label: "Brain status",
    description: "How full is the brain? Episode count + context usage (metacognition). Emits brain:overload if >80%.",
    parameters: Type.Object({}),
    async execute(_id, _p, _sig, _upd, ctx: any) {
      let usage: any = undefined;
      try {
        usage = ctx?.getContextUsage?.() ?? undefined;
      } catch {}
      const count = episodes.size;
      const pct = usage?.percent ?? (usage?.used && usage?.total ? Math.round((usage.used / usage.total) * 100) : undefined);
      const overloaded = (pct !== undefined && pct > 80) || count > 50;
      if (overloaded) (pi as any).events?.emit?.("brain:overload", { episodes: count, percent: pct });
      const txt = `Episodes: ${count}\nTokens: ${usage?.used ?? "?"} / ${usage?.total ?? "?"}${pct !== undefined ? ` (${pct}%)` : ""}${overloaded ? "\n[overload: consider compaction/pruning]" : ""}\nDeliberations: ${deliberations.length}`;
      return { content: [{ type: "text", text: txt }], details: { episodes: count, tokens: usage, recent: [...episodes.values()].slice(-3), overloaded, deliberations: deliberations.slice(-3) } };
    },
  });

  // NEW: think — PFC scratchpad for logical reasoning / deliberation
  pi.registerTool({
    name: "think",
    label: "Think",
    description: "PFC deliberation scratchpad: encode a reasoning step (goal + hypotheses) to working memory, injected next turn.",
    parameters: Type.Object({
      goal: Type.String({ description: "Reasoning goal or question" }),
      hypotheses: Type.Array(Type.String(), { description: "Hypotheses / approaches to consider", minItems: 1, maxItems: 3 }),
      conclusion: Type.Optional(Type.String({ description: "Tentative conclusion" })),
    }),
    async execute(_id, params, _signal) {
      if (needsDebugThink && !params.goal.trim().toLowerCase().startsWith("debug")) {
        return { content: [{ type: "text", text: "Blocked: unhappy path requires think{goal:'debug <failed Task N>', hypotheses:[cause,fix]} — goal must start with 'debug'" }], details: { error: "debug required" } } as any;
      }
      const wasDebug = needsDebugThink;
      const entry = { goal: truncate(params.goal), hypotheses: params.hypotheses.map(truncate), conclusion: params.conclusion ? truncate(params.conclusion) : undefined, ts: Date.now() };
      deliberations.push(entry as any);
      if (deliberations.length > 10) deliberations.shift();
      thinkSatisfied = true;
      needsDebugThink = false;
      if (wasDebug) needsPlanUpdate = true;
      (pi as any).events?.emit?.("brain:deliberation", entry);
      const text = `Deliberation saved: ${params.goal}\n- ${params.hypotheses.join("\n- ")}${params.conclusion ? `\n=> ${params.conclusion}` : ""}`;
      return { content: [{ type: "text", text: truncate(text) }], details: { deliberation: entry } };
    },
  });

  // combine/synthesize — divergent synthesis (episodes + deliberation) — ponytail: one impl, two names
  const synthesizeParams = Type.Object({
    cues: Type.Array(Type.String(), { description: "2-3 cues to combine", minItems: 2, maxItems: 3 }),
    prompt: Type.Optional(Type.String({ description: "Synthesis prompt (e.g. approach to ...)" })),
  });
  async function synthesizeExecute(_id: any, params: any, signal: any) {
    if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: {} } as any;
    const pooled: Episode[] = [];
    for (const q of params.cues) {
      const hits = [...episodes.values()]
        .map((e) => ({ e, s: scoreEpisode(e, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 2)
        .map((x) => x.e);
      pooled.push(...hits);
    }
    const unique = [...new Map(pooled.map((e) => [e.id, e])).values()].slice(0, 5);
    const recentThink = deliberations.slice(-1).map((d: any) => `[think: ${d.goal}] ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n");
    if (!unique.length && !recentThink) return { content: [{ type: "text", text: "No episodes found for cues. Use remember first." }], details: { episodes: [] } };
    const thinkGoal = (deliberations[deliberations.length-1] as any)?.goal ?? "";
    const raw = params.prompt?.trim();
    const isLoose = !raw || raw.length < 15 || /^creative approach/i.test(raw);
    const synthesisPrompt = isLoose
      ? (raw ? `${raw} — fuse ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}` : `Synthesize a novel approach combining: ${params.cues.join(" + ")}${thinkGoal ? ` + think: ${thinkGoal}` : ""}`)
      : raw;
    const sources = unique.length ? `Sources:\n${unique.map((e) => `[${e.cue}] ${e.summary}${e.detail ? ` — ${e.detail.slice(0,80)}` : ""}`).join("\n")}` : "";
    const deliberationBlock = recentThink ? `Deliberation:\n${recentThink}` : "";
    const context = [sources, deliberationBlock].filter(Boolean).join("\n\n");
    const text = `${synthesisPrompt}\n\n${context}\n\n→ Combine insights: fuse episode patterns WITH deliberation hypotheses into variant not in either source.`;
    return { content: [{ type: "text", text: truncate(text) }], details: { episodes: unique, cues: params.cues, deliberation: recentThink || undefined } };
  }
  pi.registerTool({
    name: "combine",
    label: "Combine",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach. Alias: synthesize. Prompt e.g. 'synthesize neon + login into glass login' NOT vague 'creative approach' (loose auto-enriched). No vector DB.",
    parameters: synthesizeParams,
    async execute(_id, params, signal) { return synthesizeExecute(_id, params, signal); },
  });
  pi.registerTool({
    name: "synthesize",
    label: "Synthesize",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach (clear alias for combine). Prompt e.g. 'synthesize neon + login into glass login' (loose auto-enriched). No vector DB.",
    parameters: synthesizeParams,
    async execute(_id, params, signal) { return synthesizeExecute(_id, params, signal); },
  });

  // plan — ordered tasklist after think (ponytail: one tool, id+done for updates)
  pi.registerTool({
    name: "plan",
    label: "Plan",
    description: "Create/update ordered tasklist after think (+ synthesize/combine if novel). Use after think/synthesize, before write. Tasks shown as [ ]/[x]. Pass id+done to mark complete. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Plan goal (e.g. creative login page)" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Ordered tasks", minItems: 1, maxItems: 10 })),
      id: Type.Optional(Type.String({ description: "Existing plan id to update" })),
      done: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { description: "Indices to mark done (0-based)" })),
    }),
    async execute(_id, params, _signal) {
      // update existing plan — tasks/goal optional when id provided
      if (params.id && plans.has(params.id)) {
        const pl = plans.get(params.id)!;
        if (params.done?.length) for (const i of params.done) if (pl.tasks[i]) pl.tasks[i].done = true;
        if (params.tasks?.length) {
          const existing = new Set(pl.tasks.map(t=>t.title.trim().toLowerCase()));
          for (const t of params.tasks) {
            const norm = t.trim().toLowerCase();
            if (!existing.has(norm)) { pl.tasks.push({ title: truncate(t), done: false }); existing.add(norm); }
          }
        }
        if (params.goal) pl.goal = truncate(params.goal);
        pl.ts = Date.now();
        cachedLatestPlan = pl;
        needsPlanUpdate = false;
        await (pi as any).appendEntry?.("brain:plan", pl);
        const text = renderPlan(pl) + `\n(id: ${pl.id})`;
        return { content: [{ type: "text", text: truncate(text) }], details: { plan: pl } };
      }
      // create new plan — ponytail: collision-free id, no goal slop
      if (!params.goal || !params.tasks?.length) return { content: [{ type: "text", text: "plan: goal and tasks required for new plan (use id+done to update)" }], details: { error: "missing goal/tasks" } } as any;
      const pl: Plan = {
        id: `brain-plan:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        goal: truncate(params.goal),
        tasks: params.tasks.map((t: string) => ({ title: truncate(t), done: false })),
        ts: Date.now(),
      };
      if (params.done?.length) for (const i of params.done) if (pl.tasks[i]) pl.tasks[i].done = true;
      plans.set(pl.id, pl);
      cachedLatestPlan = pl;
      needsPlanUpdate = false;
      await (pi as any).appendEntry?.("brain:plan", pl);
      (pi as any).events?.emit?.("brain:plan", pl);
      const text = renderPlan(pl) + `\n(id: ${pl.id})`;
      return { content: [{ type: "text", text: truncate(text) }], details: { plan: pl } };
    },
  });

  // T10: habit — cerebellar procedural scaffold (+ mutate variant)
  pi.registerTool({
    name: "habit",
    label: "Habit",
    description: "Create a SKILL.md scaffold for a repeated correction (cerebellum habit automatization). Draft only. Use variant mutate for creative alternative.",
    parameters: Type.Object({
      name: Type.String({ description: "Habit name (kebab-case)" }),
      when: Type.String({ description: "When to use this habit" }),
      steps: Type.String({ description: "Steps to follow" }),
      variant: Type.Optional(Type.String({ description: "Optional mutate: add creative alternative steps" })),
    }),
    async execute(_id, params, signal, _upd, ctx: any) {
      const cwd: string = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
      const safe = params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!safe) return { content: [{ type: "text", text: "Invalid habit name" }], details: { error: "empty name" } } as any;
      if (ctx?.isProjectTrusted?.() === false) return { content: [{ type: "text", text: "Project not trusted — habit blocked" }], details: { error: "untrusted" } } as any;
      const dir = `${cwd}/.pi/skills/brain-${safe}`;
      const file = `${dir}/SKILL.md`;
      const alt = params.variant ? `\n\n## Alternative (mutate)\n\n${params.variant}\n` : "";
      const body = `---\nname: brain-${safe}\ndescription: ${params.when.replace(/---/g,"—").replace(/\n/g," ").slice(0,120)}\n---\n\n# ${params.name}\n\n${params.steps}${alt}\n`;
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        if (signal?.aborted) throw new Error("aborted");
        mkdirSync(dir, { recursive: true });
        if ((pi as any).withFileMutationQueue) await (pi as any).withFileMutationQueue(file, async () => { writeFileSync(file, body, "utf8"); });
        else writeFileSync(file, body, "utf8");
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], details: { error: String(e) } };
      }
      return { content: [{ type: "text", text: `Drafted ${file}${params.variant ? " + variant" : ""}` }], details: { skillPath: dir } };
    },
  });

  // /pi-brain command — strict gate: on = brain-only, off = default pi
  pi.registerCommand("pi-brain", {
    description: "Toggle strict brain mode: /pi-brain on (answer only from brain) | /pi-brain off (default pi) | /pi-brain status",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["on", "off", "status"];
      const f = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
      return f.length ? f.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const persist = async (enabled: boolean) => {
        brainStrict = enabled;
        thinkSatisfied = false;
        needsDebugThink = false;
        needsPlanUpdate = false;
        hasWriteEdit = false;
        hasRemember = false;
        await (pi as any).appendEntry?.("brain:mode", { enabled, ts: Date.now() });
        try { (pi as any)._brainStrict = enabled; ctx?.ui?.setStatus?.("brain", enabled ? "brain: strict" : "brain: default"); } catch {}
        (pi as any).events?.emit?.("brain:mode", { enabled });
      };
      if (arg === "on" || arg === "enable" || arg === "strict") {
        await persist(true);
        ctx.ui.notify("pi-brain: ON — all queries answered strictly from brain episodes (recall-only). Use /pi-brain off to restore default.", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "default") {
        await persist(false);
        ctx.ui.notify("pi-brain: OFF — default pi behavior restored.", "info");
        return;
      }
      if (arg === "status" || arg === "") {
        const txt = `pi-brain: ${brainStrict ? "ON (strict)" : "OFF (default)"}\nEpisodes: ${episodes.size} | Deliberations: ${deliberations.length}\nUsage: /pi-brain on | /pi-brain off`;
        ctx.ui.notify(txt, "info");
        return;
      }
      ctx.ui.notify(`Unknown arg "${args}" — use /pi-brain on | /pi-brain off | /pi-brain status`, "warning");
    },
  });

  // T08: thalamic gate + context sculptor (PFC working memory)
  pi.on("input" as any, async (ev: any) => {
    if (typeof ev?.text === "string" && ev.text.startsWith("@")) {
      if (ev.text.length === 1) return { action: "continue" } as any;
      return { action: "transform", text: ev.text.slice(1) } as any;
    }
    return { action: "continue" } as any;
  });

  // strict workflow run lifecycle — reset per prompt (ponytail: unconditional reset, no timestamp drift)
  pi.on("before_agent_start" as any, async (ev: any) => {
    thinkSatisfied = false;
    hasWriteEdit = false;
    hasRemember = false;
    needsDebugThink = false;
    needsPlanUpdate = false;
    agentStartTs = Date.now();
    // strict mode: scored recall + systemPrompt clamp (Rule 1)
    if (brainStrict) {
      const query: string = ev?.prompt ?? "";
      const all = [...episodes.values()];
      const scored = all
        .map((e) => ({ e, s: scoreEpisode(e, query) }))
        .filter((x) => x.s > 0 || query.trim() === "")
        .sort((a, b) => b.s - a.s || b.e.ts - a.e.ts)
        .slice(0, 5)
        .map((x) => x.e);
      const ranked = scored.length ? scored : all.sort((a, b) => b.ts - a.ts).slice(0, 5);
      const context = ranked.length
        ? ranked.map((e) => `[${e.cue}] ${e.summary}${e.detail ? " — " + e.detail.slice(0, 160) : ""}`).join("\n")
        : "(no episodes yet — brain is empty)";
      const strictInstruction = `[STRICT BRAIN MODE ON — 7 RULES ENFORCED]\nHappy: recall → think → [synthesize/combine if novel] → plan → execute(read→edit 1 file→bash) → plan.done → remember → habit → git commit (bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>')\nUnhappy: same flow, but on ANY failure (read/edit/write/bash error, non-zero exit) you MUST call think{goal:"debug <failed Task N>", hypotheses:[root cause, fix approach]} before retry, then update plan{id,done} and retry. Execution is blocked until debug-think is done.\n\n1. Recall-first: answer ONLY from episodes below. Cite cue(s). If none relevant → "No relevant brain episode — try /pi-brain off or add with remember."\n2. Think-before-act: you MUST call think{goal,hypotheses} before any write/edit (enforced — write will be blocked otherwise).\n3. Combine-only-for-novelty: call synthesize/combine when task is creative/novel (e.g. "creative login", "novel approach"), SKIP for CRUD/bugfix — do this BEFORE planning to get all inputs.\n4. Plan-after-inputs: after think (+ synthesize/combine if used), call plan{goal,tasks[]} to create [ ] checklist, then mark [x] via plan{id,done} as you execute.\n5. Shortest-diff: read target first, edit ONE file, bash verify, no scaffolding for later.\n6. Encode: after every successful write/edit/bash you MUST call remember{cue,summary}; 2nd repeat of same fix → habit{name,when,steps}.\n7. Git: when plan 2/2 done + remember done, bash: git rev-parse --is-inside-work-tree || git init; git add -A && git commit -m 'feat: <goal>' (skip if no changes).\n\nBrain episodes for query "${query.slice(0, 120)}":\n${context}`;
      // append active plan if any (ponytail: cached, no sort)
      const latestPlan = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
      if (latestPlan) cachedLatestPlan = latestPlan;
      const planBlock = latestPlan ? `\n\nActive plan:\n${renderPlan(latestPlan)}\n(id: ${latestPlan.id})` : "";
      const strictWithPlan = strictInstruction + planBlock;
      const sys = typeof ev?.systemPrompt === "string" ? ev.systemPrompt + "\n\n" + strictWithPlan : strictWithPlan;
      return { systemPrompt: sys } as any;
    }
    // default mode: light recent injection (existing behavior)
    const recent = [...episodes.values()].sort((a, b) => b.ts - a.ts).slice(0, 3);
    const recentThink = deliberations.slice(-2);
    const latestPlanDef = cachedLatestPlan ?? [...plans.values()].sort((a,b)=>b.ts-a.ts)[0] ?? null;
    if (latestPlanDef) cachedLatestPlan = latestPlanDef;
    if (!recent.length && !recentThink.length && !latestPlanDef) return;
    const parts: string[] = [];
    if (recent.length) parts.push(`Recent brain episodes:\n${recent.map((e) => `- ${e.cue}: ${e.summary}`).join("\n")}`);
    if (recentThink.length) parts.push(`Recent deliberations:\n${recentThink.map((d: any) => `- ${d.goal}: ${d.hypotheses.join("; ")}${d.conclusion ? ` => ${d.conclusion}` : ""}`).join("\n")}`);
    if (latestPlanDef) parts.push(`Active plan:\n${renderPlan(latestPlanDef)}\n(id: ${latestPlanDef.id})`);
    return { message: { role: "system", content: parts.join("\n\n") } } as any;
  });

  pi.on("context" as any, async (ev: any) => {
    // T12 accelerate: keep working set small — prune oldest toolResults if branch huge
    const msgs: any[] = ev?.messages ?? ev?.context ?? [];
    if (msgs.length > 40) {
      const sys = msgs.filter((m: any) => m.role === "system").slice(0, 1);
      const tail = msgs.slice(-20);
      return { messages: [...sys, ...tail] } as any;
    }
  });

  // T09: hippocampal hooks — auto-encode + consolidation (sleep replay)
  pi.on("tool_result" as any, async (ev: any, ctx: any) => {
    if (ctx?.signal?.aborted) return;
    if (["edit", "write"].includes(ev?.toolName) && !ev?.isError) {
      const cue = `${ev.toolName}:${(ev.input?.path ?? "").toString().slice(0, 30)}`;
      const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
      if (summary) {
        const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto" };
        await (pi as any).appendEntry?.("brain:episode", ep);
        episodes.set(ep.id, ep);
        hasWriteEdit = true;
      }
    } else if (ev?.toolName === "bash" && !ev?.isError) {
      const cmd: string = (ev.input?.command ?? "").toString();
      const isMutating = /\b(mkdir|rm|mv|cp|touch|install|chmod|chown)\b/.test(cmd) || (cmd.includes(">") && !cmd.includes("/dev/null") && !cmd.includes("2>&1") && /[>]\s*[^\s|&;]+/.test(cmd)) || /\b(write|edit)\b/i.test(cmd);
      if (isMutating) {
        const cue = `bash:${cmd.slice(0,30)}`;
        const summary = (ev.content?.[0]?.text ?? ev.result ?? "").toString().slice(0, 200);
        if (summary) {
          const ep: Episode = { id: `${cue}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue: truncate(cue), summary: truncate(summary), ts: Date.now(), source: "auto" };
          await (pi as any).appendEntry?.("brain:episode", ep);
          episodes.set(ep.id, ep);
          hasWriteEdit = true;
        }
      }
    }
    if ((ev?.toolName === "remember" || ev?.toolName === "habit") && !ev?.isError) hasRemember = true;
    // unhappy path: any failure → require debug think before retry (enforced in tool_call)
    if (ev?.isError) {
      needsDebugThink = true;
      needsPlanUpdate = false;
      thinkSatisfied = false;
      try { (ctx as any)?.ui?.notify?.("Strict unhappy path: failure detected — call think{goal:'debug <task>', hypotheses:[...]} before retry.", "warning"); } catch {}
      const hint = "\n[ brain: failure requires debug think — call think{goal:'debug <task>', hypotheses:[cause,fix]} before retry ]";
      const cur = ev.content?.[0]?.text ?? "";
      return { content: [{ type: "text", text: truncate(cur + hint) }] } as any;
    }
  });

  pi.on("session_before_compact" as any, async (ev: any) => {
    const ranked = [...episodes.values()].sort((a, b) => b.ts - a.ts).slice(0, 5);
    if (!ranked.length) return;
    const brain = `Brain episodes:\n${ranked.map((e) => `- ${e.cue}: ${e.summary}`).join("\n")}`;
    const summary = ev?.summary ? `${brain}\n\n${ev.summary}` : brain;
    return { summary } as any;
  });

  // resources_discover: habit skills live under .pi/skills and are auto-discovered — do not inject wildcard "brain-*" (caused skill path does not exist in Test-Repo)
  pi.on("resources_discover" as any, async (ev: any) => {
    // keep auto-discovered paths as-is; habit-created .pi/skills/brain-* are already scanned
    return { skillPaths: ev?.skillPaths ?? [] } as any;
  });

  pi.on("tool_call" as any, async (ev: any, ctx: any) => {
    // rm -rf guard first (highest priority) — covers rm -fr / -r -f / --recursive --force
    if (ev?.toolName === "bash") {
      const cmd: string = ev?.input?.command ?? "";
      const low = cmd.toLowerCase();
      const isRmRf = /\brm\b/.test(low) && (/\s-[a-z]*r[a-z]*f/.test(low) || (low.includes("--recursive") && low.includes("--force")));
      if (isRmRf) {
        if (!ctx?.hasUI) return { block: true, reason: "Blocked by brain guard: rm -rf needs UI confirm" } as any;
        try {
          const ok = await ctx.ui.confirm("Dangerous", "Allow rm -rf?");
          if (!ok) return { block: true, reason: "Blocked by brain guard" } as any;
        } catch {
          return { block: true, reason: "Blocked by brain guard" } as any;
        }
      }
    }
    // unhappy path: block write/edit/bash until debug think + plan update
    if (brainStrict && needsDebugThink && ["write", "edit", "bash"].includes(ev?.toolName)) {
      return { block: true, reason: "Blocked by strict unhappy path: failure occurred — call think{goal:'debug <failed Task N>', hypotheses:[root cause, fix]} before retry." } as any;
    }
    if (brainStrict && needsPlanUpdate && ["write", "edit", "bash"].includes(ev?.toolName)) {
      return { block: true, reason: "Blocked by strict unhappy path: debug think done — now update plan{id,done} before retry." } as any;
    }
    // Rule 2: think-before-act (strict only, enforced)
    if (brainStrict && (ev?.toolName === "write" || ev?.toolName === "edit")) {
      if (!thinkSatisfied) {
        return { block: true, reason: "Blocked by strict workflow Rule 2: call think{goal,hypotheses} before write/edit. Deliberate 2-3 approaches first." } as any;
      }
    }
    // hasRemember now set in tool_result (post-success) — not here
  });

  // Rule 5: encode-or-it-didn't-happen — nudge at turn/agent end
  pi.on("turn_end" as any, async (_ev: any, ctx: any) => {
    if (brainStrict && hasWriteEdit && !hasRemember) {
      try { ctx?.ui?.notify?.("Strict Rule 5: write/edit succeeded but no remember yet — call remember{cue,summary} to persist (2nd repeat → habit).", "warning"); } catch {}
    }
  });
  pi.on("agent_end" as any, async (_ev: any, ctx: any) => {
    if (brainStrict && hasWriteEdit && !hasRemember) {
      // last chance hint; also surface as tool_result-style nudge for LLM
      try { ctx?.ui?.notify?.("Strict Rule 5: agent ended with unencoded changes — call remember now.", "warning"); } catch {}
    }
    // reset for next prompt
    hasWriteEdit = false;
  });

  // T12: accelerate — real payload trim (was void ev) + cache stability (snippet-free)
  pi.on("before_provider_request" as any, async (ev: any) => {
    try {
      const req = ev?.request ?? ev?.payload ?? ev;
      const msgs = req?.messages ?? req?.payload?.messages ?? ev?.messages;
      if (Array.isArray(msgs) && JSON.stringify(msgs).length > 30 * 1024) {
        // keep system + last 25, drop oldest toolResults — predictive trim
        const sys = msgs.filter((m: any) => m.role === "system").slice(0, 1);
        const tail = msgs.slice(-25);
        const trimmed = [...sys, ...tail];
        if (req.messages) req.messages = trimmed;
        else if (req.payload?.messages) req.payload.messages = trimmed;
      }
    } catch {}
  });

  pi.on("session_shutdown" as any, async () => {
    // idempotent — entries already durable, nothing to flush
  });

  // bus events consumed by external listeners if present
}
