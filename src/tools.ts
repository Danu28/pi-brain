import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTO_BOOST, AUTO_TTL_MS, BUDGET_STOP_PCT, BUDGET_WARN_PCT, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, MAX_BYTES, MAX_LINES, RECALL_MEMO_MS, REMEMBER_BOOST, TAG_BOOST } from "./knobs";
import { avgIdf, candidatePool, compressEpisodes, estTokens, expandTokens, gistForEpisode, indexEpisode, normalizeTags, parseSince, planTaskError, scoreBase, scoreEpisode, tokenize, truncate, unindexEpisode } from "./scoring";
import { brain, renderPlan } from "./state";
import type { BrainEpisode, BrainPlan, Deliberation } from "./types";

// consolidated 7 tools — was 8 files (432 lines) → 1 file (~360 lines)
export function registerTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember", label: "Remember",
    description: "Explicitly encode an episode to brain memory (hippocampus). Use cue as associative key. Audits before write: exact cue → upsert, similar (score≥3) → preview + needs force:true. Supports tags (≤8 kebab) and refs (≤5 files).",
    parameters: Type.Object({
      cue: Type.String({ description: "Associative cue (short key for recall)" }),
      summary: Type.String({ description: "One-line summary of episode" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for grouping (kebab, ≤8)", maxItems: 8 })),
      refs: Type.Optional(Type.Array(Type.String(), { description: "File refs (≤5)", maxItems: 5 })),
      force: Type.Optional(Type.Boolean({ description: "Force encode even if similar episodes exist (skip audit block)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cueNorm = params.cue.trim().toLowerCase();
      if (!cueNorm) return { content: [{ type: "text", text: "cue must be non-empty" }], details: { error: "empty cue" } } as any;
      if (!params.summary?.trim()) return { content: [{ type: "text", text: "summary must be non-empty" }], details: { error: "empty summary" } } as any;
      const tags = normalizeTags(params.tags as any);
      const refs = params.refs?.map((r: string)=>truncate(r)).slice(0,5);
      const exact = [...brain.episodes.values()].find(e=>e.cue.trim().toLowerCase()===cueNorm);
      if (exact && !params.force) {
        unindexEpisode(exact); exact.summary=truncate(params.summary);
        if(params.detail) exact.detail=truncate(params.detail); if(tags) exact.tags=tags; if(refs) exact.refs=refs;
        exact.ts=Date.now(); exact.source="remember"; delete (exact as any).expiresAt;
        indexEpisode(exact); await (pi as any).appendEntry?.("brain:episode", exact);
        brain.episodes.set(exact.id, exact); brain.recallMemo.clear();
        (pi as any).events?.emit?.("brain:episode:encoded", exact);
        return { content: [{ type: "text", text: `Updated (audit: exact cue exists) ${exact.id} — was duplicate cue, merged instead of new` }], details: { id: exact.id, episode: exact, audit: "exact-cue-upsert" } };
      }
      const query=`${params.cue} ${params.summary}`, terms=[...new Set(expandTokens(tokenize(query)))], idf=avgIdf(terms);
      const scored=[...brain.episodes.values()].filter(e=>e.source!=="auto").map(e=>{ const base=scoreBase(e,query,tags); return base===0?{e,s:0}:{e,s:base*idf}; }).filter(x=>x.s>=5).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts).slice(0,3);
      if (scored.length && !params.force && !exact) {
        const preview=scored.map(x=>`[${x.e.cue}] ${x.e.summary} (score:${x.s.toFixed(1)})`).join("\n");
        (pi as any).events?.emit?.("brain:remember-audit", { audit: "similar-found", similar: scored.map(x=>({cue:x.e.cue, score:x.s})), blocked: true });
        return { content: [{ type: "text", text: `Audit: ${scored.length} similar episode(s) found — not encoded.\n${preview}\n→ To update existing, reuse its cue. To force new, call remember again with force:true` }], details: { audit:"similar-found", similar:scored.map(x=>({episode:x.e,score:x.s})), blocked:true } } as any;
      }
      const ep: BrainEpisode={ id:`${params.cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue:truncate(params.cue), summary:truncate(params.summary), detail:params.detail?truncate(params.detail):undefined, tags, refs, ts:Date.now(), source:"remember" };
      await (pi as any).appendEntry?.("brain:episode", ep); brain.episodes.set(ep.id, ep); indexEpisode(ep); brain.recallMemo.clear();
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id}` }], details: { id: ep.id, episode: ep, audit: scored.length?"forced":"clean" } };
    },
  });

  pi.registerTool({
    name: "recall", label: "Recall",
    description: "Associative recall: TF-IDF cue→ranked episodes (pattern completion). Incremental token→ids index + half-life decay + tag boost + filters tags/source/since. Tag-only recall: query \"\" + tags. Batch: queries[] for 1 call = N recalls. No vector DB.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Cue to recall by" })),
      queries: Type.Optional(Type.Array(Type.String(), { description: "Batch cues (1 call = N recalls)", maxItems: 5 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (AND)", maxItems: 8 })),
      source: Type.Optional(Type.String({ description: "Filter by source: remember|auto" })),
      since: Type.Optional(Type.String({ description: "Filter since: 7d|24h|ISO|ms" })),
    }),
    async execute(_id, params, signal) {
      const limit=params.limit??5, queries:string[]=params.queries?.length?params.queries:[params.query??""];
      const normTags=normalizeTags(params.tags as any), memoKey=`${queries.join("\x00")}|${(normTags??[]).join(",")}|${params.source??""}|${params.since??""}|${limit}`;
      const cached=brain.recallMemo.get(memoKey);
      if(cached&&Date.now()-cached.ts<RECALL_MEMO_MS){ brain.memoHits++; brain.recallMemo.delete(memoKey); brain.recallMemo.set(memoKey,cached); (pi as any).events?.emit?.("brain:recall-cache", { memoKey: memoKey.slice(0,120), hits: brain.memoHits, age: Date.now()-cached.ts, cached: true }); if(signal?.aborted) return {content:[{type:"text",text:"aborted"}],details:{}} as any; return {content:[{type:"text",text:truncate(cached.text)}],details:{episodes:cached.ranked,cached:true}}; }
      const filterTags=normTags, sinceTs=parseSince(params.since as any);
      let candidates: BrainEpisode[]=[...brain.episodes.values()];
      const allQToks=[...new Set(queries.flatMap(q=>expandTokens(tokenize(q))))];
      if(allQToks.length&&brain.tokenIndex.size){
        const idSets=allQToks.map(t=>brain.tokenIndex.get(t)).filter(Boolean) as Set<string>[];
        if(idSets.length){
          const hitIds=new Set<string>(); for(const s of idSets) for(const id of s) hitIds.add(id);
          if(filterTags?.length) for(const e of brain.episodes.values()){ const eNorm=normalizeTags(e.tags)??[]; if(filterTags.some(ft=>eNorm.includes(ft))) hitIds.add(e.id); }
          const hits=[...hitIds].map(id=>brain.episodes.get(id)).filter(Boolean) as BrainEpisode[]; if(hits.length) candidates=hits;
        }
      }
      candidates=candidates.filter(e=>{ if(params.source&&e.source!==params.source) return false; if(sinceTs!==undefined&&e.ts<sinceTs) return false; if(e.expiresAt&&e.expiresAt<Date.now()) return false; if(filterTags?.length){ const eTags=normalizeTags(e.tags)??[]; if(!filterTags.every(ft=>eTags.includes(ft))) return false; } return true; });
      const terms=[...new Set(queries.flatMap(q=>expandTokens(tokenize(q))))], idf=avgIdf(terms);
      const scored=candidates.map(e=>{ const raw=Math.max(...queries.map(q=>scoreEpisode(e,q,filterTags))); return raw===0?{e,s:0}:{e,s:raw*idf}; }).filter(x=>x.s>0||queries.every(q=>q.trim()==="")||!!filterTags?.length).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts).slice(0,limit).map(x=>x.e);
      const ranked=scored.length?scored:candidates.sort((a,b)=>b.ts-a.ts).slice(0,limit);
      if(signal?.aborted) return {content:[{type:"text",text:"aborted"}],details:{}} as any;
      const text=ranked.length?ranked.map(e=>`[${e.cue}]${e.tags?.length?` [${e.tags.join(",")}]`:""} ${e.summary}${e.detail?" — "+e.detail.slice(0,120):""}${e.refs?.length?` refs:${e.refs.join(",")}`:""}`).join("\n"):"No episodes yet. Use remember to encode.";
      brain.memoMisses++; brain.recallMemo.set(memoKey,{ts:Date.now(),ranked,text}); if(brain.recallMemo.size>50){ const first=brain.recallMemo.keys().next().value; if(first) brain.recallMemo.delete(first); }
      return {content:[{type:"text",text:truncate(text)}],details:{episodes:ranked}};
    },
  });

  pi.registerTool({
    name: "think", label: "Think",
    description: "PFC deliberation scratchpad: encode a reasoning step (goal + hypotheses) to working memory, injected next turn.",
    parameters: Type.Object({ goal: Type.String({ description: "Reasoning goal or question" }), hypotheses: Type.Array(Type.String(), { description: "Hypotheses / approaches to consider", minItems: 1, maxItems: 3 }), conclusion: Type.Optional(Type.String({ description: "Tentative conclusion" })) }),
    async execute(_id, params, _signal) {
      if(brain.needsDebugThink&&!params.goal.trim().toLowerCase().startsWith("debug")) return {content:[{type:"text",text:"Blocked: unhappy path requires think{goal:'debug <failed Task N>', hypotheses:[cause,fix]} — goal must start with 'debug'"}],details:{error:"debug required"}} as any;
      const wasDebug=brain.needsDebugThink;
      const entry: Deliberation={ goal:truncate(params.goal), hypotheses:params.hypotheses.map(truncate), conclusion:params.conclusion?truncate(params.conclusion):undefined, ts:Date.now() };
      brain.deliberations.push(entry); if(brain.deliberations.length>10) brain.deliberations.shift();
      await (pi as any).appendEntry?.("brain:deliberation", entry); brain.thinkSatisfied=true; brain.needsDebugThink=false; if(wasDebug) brain.needsPlanUpdate=true;
      (pi as any).events?.emit?.("brain:deliberation", entry);
      return {content:[{type:"text",text:truncate(`Deliberation saved: ${params.goal}\n- ${params.hypotheses.join("\n- ")}${params.conclusion?`\n=> ${params.conclusion}`:""}`)}],details:{deliberation:entry}};
    },
  });

  const creativeParams=Type.Object({ cues:Type.Array(Type.String(),{description:"2-3 cues to combine",minItems:2,maxItems:3}), prompt:Type.Optional(Type.String({description:"Synthesis prompt (e.g. approach to ...)"})) });
  pi.registerTool({
    name: "creative-thinking", label: "Creative Thinking",
    description: "Creative synthesis: fuse distant episodes + latest think into novel approach. Prompt e.g. 'creative-thinking neon + login into glass login' NOT vague 'creative approach' (loose auto-enriched). No vector DB.",
    parameters: creativeParams,
    async execute(_id, params, signal) {
      if(signal?.aborted) return {content:[{type:"text",text:"aborted"}],details:{}} as any;
      const pooled: BrainEpisode[]=[]; for(const q of params.cues){ const hits=candidatePool(q).map(e=>({e,s:scoreEpisode(e,q)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,2).map(x=>x.e); pooled.push(...hits); }
      const unique=[...new Map(pooled.map(e=>[e.id,e])).values()].slice(0,5);
      const recentThink=brain.deliberations.slice(-1).map((d:any)=>`[think: ${d.goal}] ${d.hypotheses.join("; ")}${d.conclusion?` => ${d.conclusion}`:""}`).join("\n");
      if(!unique.length&&!recentThink) return {content:[{type:"text",text:"No episodes found for cues. Use remember first."}],details:{episodes:[]}};
      const thinkGoal=brain.deliberations[brain.deliberations.length-1]?.goal??"", raw=params.prompt?.trim(), isLoose=!raw||raw.length<15||/^creative approach/i.test(raw);
      const synthesisPrompt=isLoose?(raw?`${raw} — fuse ${params.cues.join(" + ")}${thinkGoal?` + think: ${thinkGoal}`:""}`:`Create a novel approach combining: ${params.cues.join(" + ")}${thinkGoal?` + think: ${thinkGoal}`:""}`):raw;
      const sources=unique.length?`Sources:\n${unique.map(e=>`[${e.cue}] ${gistForEpisode(e)}`).join("\n")}`:"", deliberationBlock=recentThink?`Deliberation:\n${recentThink}`:"", context=[sources,deliberationBlock].filter(Boolean).join("\n\n");
      return {content:[{type:"text",text:truncate(`${synthesisPrompt}\n\n${context}\n\n→ Combine insights: fuse episode patterns WITH deliberation hypotheses into variant not in either source.`)}],details:{episodes:unique,cues:params.cues,deliberation:recentThink||undefined}};
    },
  });

  pi.registerTool({
    name: "plan", label: "Plan",
    description: "Create/update detailed ordered tasklist after think (+ creative-thinking if novel). Requires 3-10 well-split tasks that match user requirement — detailed enough that execution is easy. Tasks shown as [ ]/[x]. Pass id+done to mark complete. Single-shot: include hypotheses to auto-create deliberation. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Plan goal (e.g. creative login page)" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Detailed ordered tasks (3-10, well-split; >10 → chunk via plan{id,tasks:[...]}). Validation in executor for actionable errors." })),
      id: Type.Optional(Type.String({ description: "Existing plan id to update" })),
      done: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { description: "Indices to mark done (0-based)" })),
      hypotheses: Type.Optional(Type.Array(Type.String(), { description: "Single-shot hypotheses (auto-creates think)", minItems: 1, maxItems: 3 })),
    }),
    async execute(_id, params, _signal) {
      if(params.id&&brain.plans.has(params.id)){
        const pl=brain.plans.get(params.id)!; if(params.done?.length) for(const i of params.done) if(pl.tasks[i]) pl.tasks[i].done=true;
        if(params.tasks?.length){ const existing=new Set(pl.tasks.map(t=>t.title.trim().toLowerCase())); for(const t of params.tasks){ const norm=t.trim().toLowerCase(); if(!existing.has(norm)){ pl.tasks.push({title:truncate(t),done:false}); existing.add(norm); } } }
        if(params.goal) pl.goal=truncate(params.goal); pl.ts=Date.now(); brain.cachedLatestPlan=pl; brain.needsPlanUpdate=false; await (pi as any).appendEntry?.("brain:plan", pl);
        return {content:[{type:"text",text:truncate(renderPlan(pl)+`\n(id: ${pl.id})`)}],details:{plan:pl}};
      }
      if(params.hypotheses?.length){
        if(params.hypotheses.length<2) return {content:[{type:"text",text:"plan single-shot: hypotheses needs 2-3 detailed (≥10 chars each) — deliberation requires 2 approaches"}],details:{error:"hypotheses too few"}} as any;
        if(params.hypotheses.some((h:string)=>h.trim().length<10)) return {content:[{type:"text",text:"plan hypotheses must be detailed (≥10 chars each)"}],details:{error:"hypotheses not detailed"}} as any;
        const entry: Deliberation={ goal:params.goal??"plan deliberation", hypotheses:params.hypotheses.map((h:string)=>truncate(h)), ts:Date.now() };
        brain.deliberations.push(entry); if(brain.deliberations.length>10) brain.deliberations.shift(); await (pi as any).appendEntry?.("brain:deliberation", entry); brain.thinkSatisfied=true; brain.needsDebugThink=false; if(entry.goal.toLowerCase().trim().startsWith("debug")) brain.needsPlanUpdate=true;
        (pi as any).events?.emit?.("brain:deliberation", entry); (pi as any).events?.emit?.("brain:plan-think-single-shot", { goal: entry.goal, hypotheses: entry.hypotheses });
      }
      if(!params.goal||!params.tasks?.length) return {content:[{type:"text",text:"plan: goal and tasks required for new plan (use id+done to update)"}],details:{error:"missing goal/tasks"}} as any;
      const taskErr=planTaskError(params.tasks); if(taskErr) return {content:[{type:"text",text:taskErr}],details:{error:"invalid tasks",count:params.tasks.length}} as any;
      const pl: BrainPlan={ id:`brain-plan:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, goal:truncate(params.goal), tasks:params.tasks.map((t:string)=>({title:truncate(t),done:false})), ts:Date.now() };
      if(params.done?.length) for(const i of params.done) if(pl.tasks[i]) pl.tasks[i].done=true;
      brain.plans.set(pl.id, pl); brain.cachedLatestPlan=pl; brain.needsPlanUpdate=false; await (pi as any).appendEntry?.("brain:plan", pl); (pi as any).events?.emit?.("brain:plan", pl);
      return {content:[{type:"text",text:truncate(renderPlan(pl)+`\n(id: ${pl.id})`)}],details:{plan:pl}};
    },
  });

  pi.registerTool({
    name: "habit", label: "Habit",
    description: "Habitize a repeated fix: scaffold .pi/skills/brain-<name>/SKILL.md (preview if exists, force:true to overwrite, variant adds alternative, blocked in untrusted projects, undo: rm -r <dir>). Call after 2nd repeat of same remember.",
    parameters: Type.Object({
      name: Type.String({ description: "Habit name (kebab-case)" }),
      when: Type.String({ description: "When to use this habit" }),
      steps: Type.String({ description: "Steps to follow" }),
      variant: Type.Optional(Type.String({ description: "Optional mutate: add creative alternative steps" })),
      force: Type.Optional(Type.Boolean({ description: "Confirm overwrite when preview exists" })),
    }),
    async execute(_id, params, signal, _upd, ctx: any) {
      const cwd:string=ctx?.cwd?? (pi as any).cwd?? process.cwd(), safe=params.name.toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
      if(!safe) return {content:[{type:"text",text:"Invalid habit name"}],details:{error:"empty name"}} as any;
      if(ctx?.isProjectTrusted?.()===false) return {content:[{type:"text",text:"Project not trusted — habit blocked"}],details:{error:"untrusted"}} as any;
      const dir=`${cwd}/.pi/skills/brain-${safe}`, file=`${dir}/SKILL.md`;
      if(!params.force){ try{ const {readFileSync}=await import("node:fs"); const existing=readFileSync(file,"utf8"); const preview=existing.slice(0,400).replace(/\n/g," "); const altHint=params.variant?" + variant":" — add variant to enrich"; return {content:[{type:"text",text:`Preview: habit exists at ${file}:\n${preview}\n→ call again with force:true to confirm overwrite${altHint}. Undo: rm -r ${dir}`}],details:{blocked:true,existing,preview}} as any; }catch{} }
      const alt=params.variant?`\n\n## Alternative (mutate)\n\n${params.variant}\n`:"", body=`---\nname: brain-${safe}\ndescription: ${params.when.replace(/---/g,"—").replace(/\n/g," ").slice(0,120)}\n---\n\n# ${params.name}\n\n${params.steps}${alt}\n`;
      try{ const {mkdirSync,writeFileSync}=await import("node:fs"); if(signal?.aborted) throw new Error("aborted"); mkdirSync(dir,{recursive:true}); if((pi as any).withFileMutationQueue) await (pi as any).withFileMutationQueue(file, async()=>{writeFileSync(file,body,"utf8");}); else writeFileSync(file,body,"utf8"); }catch(e:any){ return {content:[{type:"text",text:`Failed: ${e.message}`}],details:{error:String(e)}}; }
      return {content:[{type:"text",text:`Drafted ${file}${params.variant?" + variant":""} — undo: rm -r ${dir}`}],details:{skillPath:dir}};
    },
  });

  pi.registerTool({
    name: "brain-status", label: "Brain status",
    description: "How full is the brain? Episode count + context usage (metacognition). Emits brain:overload if >80%. Shows index stats + calibration knobs.",
    parameters: Type.Object({}),
    async execute(_id, _p, _sig, _upd, ctx: any) {
      let usage:any=undefined; try{ usage=ctx?.getContextUsage?.()?? (pi as any).getContextUsage?.()??undefined; }catch{}
      const count=brain.episodes.size, autoCount=[...brain.episodes.values()].filter(e=>e.source==="auto").length, remCount=count-autoCount;
      const pct=usage?.percent??(usage?.used&&usage?.total?Math.round(usage.used/usage.total*100):undefined), overloaded=(pct!==undefined&&pct>80)||count>50;
      if(overloaded) (pi as any).events?.emit?.("brain:overload",{episodes:count,percent:pct});
      const idxStats=`Index: ${brain.tokenIndex.size} tokens → ${count} episodes (${remCount} remember, ${autoCount} auto) | memo hits:${brain.memoHits} miss:${brain.memoMisses}`;
      const gistPreview=[...brain.episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map(gistForEpisode).join(" | "), gistTokens=estTokens(gistPreview);
      const knobs=`Knobs: MAX_BYTES=${MAX_BYTES} MAX_LINES=${MAX_LINES} TAG_BOOST=${TAG_BOOST} HALF_LIFE=${HALF_LIFE_FACTOR}/${HALF_LIFE_DAYS}d REMEMBER_BOOST=${REMEMBER_BOOST} AUTO_BOOST=${AUTO_BOOST} TTL=${AUTO_TTL_MS/86400000}d`;
      const budget=pct!==undefined?`Budget: ${pct}% ${pct>BUDGET_STOP_PCT?"(STOP inject)":pct>BUDGET_WARN_PCT?"(warn: inject 1)":""}`:`Budget: est ${gistTokens} tokens gist`;
      const txt=`Episodes: ${count} (${remCount} remember, ${autoCount} auto)\nTokens: ${usage?.used??"?"} / ${usage?.total??"?"}${pct!==undefined?` (${pct}%)`:""}${overloaded?"\n[overload: consider compaction/pruning]":""}\nDeliberations: ${brain.deliberations.length}\n${idxStats}\nGist preview (${gistTokens} tok): ${gistPreview.slice(0,120)}\n${knobs}\n${budget}`;
      return {content:[{type:"text",text:txt}],details:{episodes:count,autoCount,remCount,tokens:usage,recent:[...brain.episodes.values()].slice(-3),overloaded,deliberations:brain.deliberations.slice(-3),index:{tokens:brain.tokenIndex.size,episodes:count,memoHits:brain.memoHits,memoMisses:brain.memoMisses},knobs:{MAX_BYTES,MAX_LINES,TAG_BOOST,HALF_LIFE_DAYS,HALF_LIFE_FACTOR,REMEMBER_BOOST,AUTO_BOOST}}};
    },
  });
}
