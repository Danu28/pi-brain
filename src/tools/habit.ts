import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerHabit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "habit",
    label: "Habit",
    description: "Create/update detailed ordered tasklist after think (+ creative-thinking if novel). Requires 3-10 well-split tasks that match user requirement — detailed enough that execution is easy. Tasks shown as [ ]/[x]. Pass id+done to mark complete. Single-shot: include hypotheses to auto-create deliberation. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      name: Type.String({ description: "Habit name (kebab-case)" }),
      when: Type.String({ description: "When to use this habit" }),
      steps: Type.String({ description: "Steps to follow" }),
      variant: Type.Optional(Type.String({ description: "Optional mutate: add creative alternative steps" })),
      force: Type.Optional(Type.Boolean({ description: "Confirm overwrite when preview exists" })),
    }),
    async execute(_id, params, signal, _upd, ctx: any) {
      const cwd: string = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
      const safe = params.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!safe) return { content: [{ type: "text", text: "Invalid habit name" }], details: { error: "empty name" } } as any;
      if (ctx?.isProjectTrusted?.() === false) return { content: [{ type: "text", text: "Project not trusted — habit blocked" }], details: { error: "untrusted" } } as any;
      const dir = `${cwd}/.pi/skills/brain-${safe}`;
      const file = `${dir}/SKILL.md`;
      // preview: if exists, require force:true to confirm overwrite
      if (!params.force) {
        try {
          const { readFileSync } = await import("node:fs");
          const existing = readFileSync(file, "utf8");
          const preview = existing.slice(0, 400).replace(/\n/g, " ");
          const altHint = params.variant ? " + variant" : " — add variant to enrich";
          return { content: [{ type: "text", text: `Preview: habit exists at ${file}:\n${preview}\n→ call again with force:true to confirm overwrite${altHint}. Undo: rm -r ${dir}` }], details: { blocked: true, existing, preview } } as any;
        } catch {}
      }
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
      return { content: [{ type: "text", text: `Drafted ${file}${params.variant ? " + variant" : ""} — undo: rm -r ${dir}` }], details: { skillPath: dir } };
    },
  });
}