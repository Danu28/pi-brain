import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { planTaskError } from "../validation";
import { brain, renderPlan } from "../state";
import type { BrainPlan, Deliberation } from "../types";
import { truncate } from "../util";

export function registerPlan(pi: ExtensionAPI) {
  pi.registerTool({
    name: "plan",
    label: "Plan",
    description: "Create/update detailed ordered tasklist after think (+ creative-thinking if novel). Requires 3-10 well-split tasks that match user requirement — detailed enough that execution is easy. Tasks shown as [ ]/[x]. Pass id+done to mark complete. Single-shot: include hypotheses to auto-create deliberation. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Plan goal (e.g. creative login page)" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Detailed ordered tasks (3-10, well-split; >10 → chunk via plan{id,tasks:[...]}). Validation in executor for actionable errors." })),
      id: Type.Optional(Type.String({ description: "Existing plan id to update" })),
      done: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { description: "Indices to mark done (0-based)" })),
      hypotheses: Type.Optional(Type.Array(Type.String(), { description: "Single-shot hypotheses (auto-creates think)", minItems: 1, maxItems: 3 })),
    }),
    async execute(_id, params, _signal) {
      // update existing plan — tasks/goal optional when id provided
      if (params.id && brain.plans.has(params.id)) {
        const pl = brain.plans.get(params.id)!;
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
        brain.cachedLatestPlan = pl;
        brain.needsPlanUpdate = false;
        await (pi as any).appendEntry?.("brain:plan", pl);
        const text = renderPlan(pl) + `\n(id: ${pl.id})`;
        return { content: [{ type: "text", text: truncate(text) }], details: { plan: pl } };
      }
      // single-shot: hypotheses → auto-create deliberation (2 calls → 1) — prefer this, 2 hypotheses min for real deliberation
      if (params.hypotheses?.length) {
        if (params.hypotheses.length < 2) return { content: [{ type: "text", text: "plan single-shot: hypotheses needs 2-3 detailed (≥10 chars each) — deliberation requires 2 approaches" }], details: { error: "hypotheses too few" } } as any;
        if (params.hypotheses.some((h: string) => h.trim().length < 10)) return { content: [{ type: "text", text: "plan hypotheses must be detailed (≥10 chars each)" }], details: { error: "hypotheses not detailed" } } as any;
        const entry: Deliberation = { goal: params.goal ?? "plan deliberation", hypotheses: params.hypotheses.map((h: string) => truncate(h)), ts: Date.now() };
        brain.deliberations.push(entry);
        if (brain.deliberations.length > 10) brain.deliberations.shift();
        await (pi as any).appendEntry?.("brain:deliberation", entry);
        brain.thinkSatisfied = true;
        brain.needsDebugThink = false;
        if (entry.goal.toLowerCase().trim().startsWith("debug")) brain.needsPlanUpdate = true;
      }
      // create new plan — collision-free id, no goal slop — enforce detailed 3-10 split
      if (!params.goal || !params.tasks?.length) return { content: [{ type: "text", text: "plan: goal and tasks required for new plan (use id+done to update)" }], details: { error: "missing goal/tasks" } } as any;
      const taskErr = planTaskError(params.tasks);
      if (taskErr) return { content: [{ type: "text", text: taskErr }], details: { error: "invalid tasks", count: params.tasks.length } } as any;
      const pl: BrainPlan = {
        id: `brain-plan:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        goal: truncate(params.goal),
        tasks: params.tasks.map((t: string) => ({ title: truncate(t), done: false })),
        ts: Date.now(),
      };
      if (params.done?.length) for (const i of params.done) if (pl.tasks[i]) pl.tasks[i].done = true;
      brain.plans.set(pl.id, pl);
      brain.cachedLatestPlan = pl;
      brain.needsPlanUpdate = false;
      await (pi as any).appendEntry?.("brain:plan", pl);
      (pi as any).events?.emit?.("brain:plan", pl);
      const text = renderPlan(pl) + `\n(id: ${pl.id})`;
      return { content: [{ type: "text", text: truncate(text) }], details: { plan: pl } };
    },
  });
}