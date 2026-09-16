import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTO_BOOST, AUTO_TTL_MS, BUDGET_STOP_PCT, BUDGET_WARN_PCT, HALF_LIFE_DAYS, HALF_LIFE_FACTOR, MAX_BYTES, MAX_LINES, RECALL_MEMO_MS, RELEVANCE_MIN_RECALL, RELEVANCE_MIN_REMEMBER, REMEMBER_BOOST, TAG_BOOST } from "./knobs";
import { avgIdf, candidatePool, compressEpisodes, estTokens, expandTokens, formatRelevance, gistForEpisode, indexEpisode, normalizeTags, parseDebater, parseSince, planTaskError, relevanceForRemember, relevanceLabel, rubricForHypothesis, scoreBase, scoreEpisode, tokenize, truncate, unindexEpisode } from "./scoring";
import { brain, isVerbose, renderPlan } from "./state";
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
      // QDS 1) Question — does it matter enough to keep? (human forgetting)
      const rel = relevanceForRemember(params.cue, params.summary, params.detail, tags, refs);
      const exact = [...brain.episodes.values()].find(e=>e.cue.trim().toLowerCase()===cueNorm);
      if (exact && !params.force) {
        unindexEpisode(exact); exact.summary=truncate(params.summary);
        if(params.detail) exact.detail=truncate(params.detail); if(tags) exact.tags=tags; if(refs) exact.refs=refs;
        exact.ts=Date.now(); exact.source="remember"; exact.relevance = rel.score; delete (exact as any).expiresAt;
        indexEpisode(exact); await (pi as any).appendEntry?.("brain:episode", exact);
        brain.episodes.set(exact.id, exact); brain.recallMemo.clear();
        (pi as any).events?.emit?.("brain:episode:encoded", exact);
        return { content: [{ type: "text", text: `Updated (audit: exact cue exists) ${exact.id} — was duplicate cue, merged instead of new | relevance ${formatRelevance(rel.score)} — ${rel.reasons.join(", ")}` }], details: { id: exact.id, episode: exact, audit: "exact-cue-upsert", relevance: rel } };
      }
      // QDS 2) Delete — remove trivia (waste of space, pollutes memory like human forgetting)
      if (!params.force && rel.score < RELEVANCE_MIN_REMEMBER) {
        return { content: [{ type: "text", text: `QDS Delete: not relevant enough to remember — relevance ${formatRelevance(rel.score)} (need ≥${RELEVANCE_MIN_REMEMBER})\nReasons: ${rel.reasons.join(", ")}\nTip: remembering noise pollutes memory — add detail/tags/refs or longer summary (50-120 chars ideal), or force:true to override` }], details: { audit: "relevance-low", relevance: rel, blocked: true } } as any;
      }
      const query=`${params.cue} ${params.summary}`, terms=[...new Set(expandTokens(tokenize(query)))], idf=avgIdf(terms);
      const scored=[...brain.episodes.values()].filter(e=>e.source!=="auto").map(e=>{ const base=scoreBase(e,query,tags); return base===0?{e,s:0}:{e,s:base*idf}; }).filter(x=>x.s>=5).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts).slice(0,3);
      if (scored.length && !params.force && !exact) {
        brain.stats.audit++; const preview=scored.map(x=>`[${x.e.cue}] ${x.e.summary} (score:${x.s.toFixed(1)})`).join("\n");
        (pi as any).events?.emit?.("brain:remember-audit", { audit: "similar-found", similar: scored.map(x=>({cue:x.e.cue, score:x.s})), blocked: true });
        if (isVerbose()) try { (pi as any).events?.emit?.("brain:verbose", `remember audit blocked ${scored.length}`); } catch {}
        return { content: [{ type: "text", text: `Audit: ${scored.length} similar episode(s) found — not encoded.\n${preview}\n→ To update existing, reuse its cue. To force new, call remember again with force:true | relevance ${formatRelevance(rel.score)}` }], details: { audit:"similar-found", similar:scored.map(x=>({episode:x.e,score:x.s})), relevance: rel, blocked:true } } as any;
      }
      // QDS 3) Simplify — keep gist (truncate already) + relevance visible
      const ep: BrainEpisode={ id:`${params.cue.replace(/[^a-z0-9-]/gi,"-").slice(0,30)}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, cue:truncate(params.cue), summary:truncate(params.summary), detail:params.detail?truncate(params.detail):undefined, tags, refs, ts:Date.now(), source:"remember", relevance: rel.score };
      await (pi as any).appendEntry?.("brain:episode", ep); brain.episodes.set(ep.id, ep); indexEpisode(ep); brain.recallMemo.clear();
      (pi as any).events?.emit?.("brain:episode:encoded", ep);
      return { content: [{ type: "text", text: `Encoded ${ep.id} | relevance ${formatRelevance(rel.score)} (${rel.label}) — ${rel.reasons.join(", ")}` }], details: { id: ep.id, episode: ep, audit: scored.length?"forced":"clean", relevance: rel } };
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
      // QDS 1) Question — challenge each episode: does it matter for query?
      const scoredAll=candidates.map(e=>{ const raw=Math.max(...queries.map(q=>scoreEpisode(e,q,filterTags))); return raw===0?{e,s:0}:{e,s:raw*idf}; }).filter(x=>x.s>0||queries.every(q=>q.trim()==="")||!!filterTags?.length).sort((a,b)=>b.s-a.s||b.e.ts-a.e.ts).slice(0,limit);
      // QDS 2) Delete — remove trivia that would divert AI (relevance < threshold)
      const isTagOnly = queries.every(q=>q.trim()==="") && !!filterTags?.length;
      const scored = isTagOnly ? scoredAll : scoredAll.filter(x=> x.s >= RELEVANCE_MIN_RECALL);
      const deletedCount = scoredAll.length - scored.length;
      const ranked=scored.length?scored.map(x=>x.e): (scoredAll.length ? [] as BrainEpisode[] : candidates.sort((a,b)=>b.ts-a.ts).slice(0,limit));
      if(signal?.aborted) return {content:[{type:"text",text:"aborted"}],details:{}} as any;
      // QDS 3) Simplify — show memory with its relevance (like human seeing relevance)
      const withRel = scored.map(x=>({ e: x.e, s: x.s, rel: Math.min(10, Math.round(x.s*10)/10) }));
      // enhanced: think graph traversal + time-travel replay
      // if query is "replay:think:<id>" or "think:<id>" → return that deliberation directly
      const replayId = queries[0]?.match(/(think:[\w:-]+)/)?.[1];
      if (replayId) {
        const delib = brain.deliberations.find(d=> d.id===replayId);
        if (delib) {
          const replayText = `Replay ${delib.id}${delib.parentId?` (parent ${delib.parentId})`:""}: ${delib.goal}\n` +
            (delib.debaters? `Debate:\n` + delib.debaters.map((d:any,i:number)=>` ${i===0?"A":"B"}: ${d.side} ${formatRelevance(d.relevance)} — ${d.argues} uses:[${d.uses.join(",")||"none"}]`).join("\n") + `\nWinner: ${delib.winner} ${delib.rubric?`— A ${delib.rubric.a.avg}/10 vs B ${delib.rubric.b.avg}/10`:""}` : `- ${delib.hypotheses.join("\n- ")}`) +
            (delib.conclusion?`\n=> ${delib.conclusion}`:"") + (delib.links?.length?`\nLinks:[${delib.links.join(",")}]`:"");
          return {content:[{type:"text",text:truncate(replayText)}],details:{deliberation:delib, replay:true}} as any;
        }
      }
      // attach relevant think nodes (graph traversal) — like recall also finds deliberations that debated this topic
      const thinkHits = brain.deliberations.map(d=>{
        const pseudo = { cue: d.goal, summary: d.hypotheses.join(" "), detail: d.conclusion, tags: d.links } as any;
        const s = scoreBase(pseudo, queries[0]||"") * 1.2; // slight boost for deliberation
        return { d, s };
      }).filter(x=>x.s>=3).sort((a,b)=>b.s-a.s).slice(0,2);
      const thinkBlock = thinkHits.length ? `\n\n[Think Graph — time-travel replay]:\n` + thinkHits.map(({d,s})=> `- ${d.id}${d.parentId?` (parent ${d.parentId})`:""}: ${d.goal} — winner:${d.winner||"n/a"} — ${formatRelevance(Math.min(10,Math.round(s*10)/10))} — links:[${(d.links||[]).join(",")||"none"}] — replay: recall{query:"${d.id}"}`).join("\n") : "";
      const text=ranked.length
        ? withRel.map(({e,s})=> {
            const relScore = Math.min(10, Math.round(s*10)/10);
            const relStr = formatRelevance(relScore);
            return `[${e.cue}] ${relStr}${e.tags?.length?` [${e.tags.join(",")}]`:""} ${e.summary}${e.detail?" — "+e.detail.slice(0,120):""}${e.refs?.length?` refs:${e.refs.join(",")}`:""}${e.relevance!==undefined?` (stored ${formatRelevance(e.relevance)})`:""}`;
          }).join("\n") + (deletedCount ? `\n\n[QDS Delete: ${deletedCount} low-relevance hidden — relevance < ${RELEVANCE_MIN_RECALL} — not shown to avoid diverting AI]` : "") + thinkBlock
        : scoredAll.length && !scored.length ? `No relevant episodes (all ${scoredAll.length} hits below relevance ${RELEVANCE_MIN_RECALL}). Not adding noise into context — let AI read files to get understanding instead.` + thinkBlock
        : thinkHits.length ? `No episodes, but relevant think graph:` + thinkBlock
        : "No episodes yet. Use remember to encode — only what matters in future, remembering noise pollutes memory.";
      brain.memoMisses++; brain.recallMemo.set(memoKey,{ts:Date.now(),ranked, text}); if(brain.recallMemo.size>50){ const first=brain.recallMemo.keys().next().value; if(first) brain.recallMemo.delete(first); }
      return {content:[{type:"text",text:truncate(text)}],details:{episodes:ranked, scores: withRel.map(x=>({ cue: x.e.cue, final: x.s, relevance: x.rel, label: relevanceLabel(x.rel) })), deletedCount, thinkHits: thinkHits.map(x=>({ id: x.d.id, goal: x.d.goal, winner: x.d.winner, score: x.s })), qds: "Question→Delete→Simplify"}};
    },
  });

  pi.registerTool({
    name: "think", label: "Think",
    description: "PFC debate graph: 2 debaters + judge + memory links — hypotheses are scored via rubric cost/risk/reversibility/relevance, winner pinned, loser pruned, graph replayable via recall. Clean: explicit, no hidden.",
    parameters: Type.Object({
      goal: Type.String({ description: "Reasoning goal or question" }),
      hypotheses: Type.Array(Type.String(), { description: "Hypotheses — each debater: \"Side A | cost:3 risk:2 rev:9 | argues...\" or plain argues. QDS Delete <4 hidden.", minItems: 1, maxItems: 3 }),
      conclusion: Type.Optional(Type.String({ description: "Tentative conclusion / judge reason" })),
      parentId: Type.Optional(Type.String({ description: "Parent deliberation id for branching / time-travel" })),
    }),
    async execute(_id, params, _signal) {
      if(brain.needsDebugThink&&!params.goal.trim().toLowerCase().startsWith("debug")) return {content:[{type:"text",text:"Blocked: unhappy path requires think{goal:'debug <failed Task N>', hypotheses:[cause,fix]} — goal must start with 'debug'"}],details:{error:"debug required"}} as any;
      const wasDebug=brain.needsDebugThink;
      // QDS + Debate: Question each hypothesis, Delete low relevance, Simplify to rubric
      const rawHyps = params.hypotheses.map((h:string)=>truncate(h));
      const parsed = rawHyps.map((h:string)=>{
        const rel = relevanceForRemember(params.goal, h, undefined, undefined, undefined);
        const rubric = rubricForHypothesis(h, rel.score);
        const p = parseDebater(h);
        return { raw:h, side:p.side, argues:p.argues, rel, rubric, uses: [] as string[] };
      });
      // link each hypothesis to top episodes (memory graph)
      for (const d of parsed) {
        const pool = candidatePool(d.argues || d.side).map(e=>({e,s:scoreEpisode(e,d.argues)})).filter(x=>x.s>=3).sort((a,b)=>b.s-a.s).slice(0,1).map(x=>x.e.id);
        d.uses = pool;
      }
      const goalPool = candidatePool(params.goal).map(e=>({e,s:scoreEpisode(e,params.goal)})).filter(x=>x.s>=3).sort((a,b)=>b.s-a.s).slice(0,2).map(x=>x.e.id);
      // Delete trivia hypotheses (<4) if we have 3 — keep at least 2
      let kept = parsed;
      if (parsed.length===3) {
        const filtered = parsed.filter(d=> d.rel.score >= 4);
        if (filtered.length>=2) kept = filtered;
      }
      const hypotheses = kept.map(k=>k.raw);
      // Judge: winner = highest rubric avg
      let winner: string | undefined, rubric: any = undefined;
      let debaters: any[] | undefined;
      if (kept.length>=2) {
        const sorted = [...kept].sort((a,b)=>b.rubric.avg - a.rubric.avg);
        winner = sorted[0].side;
        rubric = { a: kept[0].rubric, b: kept[1].rubric };
        debaters = kept.map(k=>({ side:k.side, argues:k.argues, relevance:k.rel.score, uses:k.uses }));
        // Auto-prune: loser side episodes get faster decay — emit event for observability
        const loser = sorted[1];
        if (loser.uses.length) (pi as any).events?.emit?.("brain:prune", { reason:"debate loser", loser: loser.side, epIds: loser.uses });
        // Pin winner side — boost relevance
        const winnerUses = sorted[0].uses;
        for (const id of winnerUses) { const ep=brain.episodes.get(id); if(ep) ep.relevance = Math.min(10, (ep.relevance ?? 5) + 0.5); }
      }
      const links = [...new Set([...goalPool, ...kept.flatMap(k=>k.uses)])].slice(0,4);
      const id = `think:${Date.now()}:${Math.random().toString(36).slice(2,6)}`;
      const parentId = (params as any).parentId as string | undefined;
      const entry: Deliberation={
        id, parentId, goal:truncate(params.goal), hypotheses, conclusion:params.conclusion?truncate(params.conclusion): (winner ? `Judge: ${winner} wins — ` + kept.map(k=> `${k.side} ${k.rubric.avg}/10`).join(" vs ") : undefined),
        ts:Date.now(), debaters, rubric, winner, links,
        score: kept.length ? Math.round(kept.reduce((a,b)=>a+b.rel.score,0)/kept.length*10)/10 : undefined,
      };
      brain.deliberations.push(entry); if(brain.deliberations.length>10) brain.deliberations.shift();
      await (pi as any).appendEntry?.("brain:deliberation", entry); brain.thinkSatisfied=true; brain.needsDebugThink=false; if(wasDebug) brain.needsPlanUpdate=true;
      (pi as any).events?.emit?.("brain:deliberation", entry);
      if (debaters) (pi as any).events?.emit?.("brain:debate", { id, goal: entry.goal, debaters, winner, rubric, links, parentId });
      const debateBlock = debaters ? `\nDebate:\n` + debaters.map((d:any, i:number)=>` ${i===0?"A":"B"}: ${d.side} — ${formatRelevance(d.relevance)} cost:${rubric[i===0?"a":"b"].cost} risk:${rubric[i===0?"a":"b"].risk} rev:${rubric[i===0?"a":"b"].reversibility} avg:${rubric[i===0?"a":"b"].avg} uses:[${d.uses.join(",")||"none"}]`).join("\n") + `\nJudge: ${winner} wins` + (links.length?` — links:[${links.join(",")}]`:"") + (parentId?` — parent:${parentId}`:"") : "";
      const keptNote = kept.length < parsed.length ? `\n[QDS Delete: ${parsed.length - kept.length} low-relevance hypothesis hidden <4/10]` : "";
      return {content:[{type:"text",text:truncate(`Deliberation ${id}${parentId?` (parent ${parentId})`:""}: ${params.goal}\n- ${hypotheses.join("\n- ")}${entry.conclusion?`\n=> ${entry.conclusion}`:""}${debateBlock}${keptNote}`)}],details:{deliberation:entry, debate: debaters?{debaters, winner, rubric, links, parentId}: undefined}};
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
    description: "Create/update detailed ordered tasklist after think (+ creative-thinking if novel). Requires 3-10 well-split tasks that match user requirement — detailed enough that execution is easy. Tasks shown as [ ]/[x]. Pass id+done to mark complete. Clean: requires prior think — no hypotheses shortcut. When all [x], bash: git init if needed (git rev-parse || git init) + git add -A && git commit.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Plan goal (e.g. creative login page)" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Detailed ordered tasks (3-10, well-split; >10 → chunk via plan{id,tasks:[...]}). Validation in executor for actionable errors." })),
      id: Type.Optional(Type.String({ description: "Existing plan id to update" })),
      done: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { description: "Indices to mark done (0-based)" })),
    }),
    async execute(_id, params, _signal) {
      if(params.id&&brain.plans.has(params.id)){
        const pl=brain.plans.get(params.id)!; if(params.done?.length) for(const i of params.done) if(pl.tasks[i]) pl.tasks[i].done=true;
        if(params.tasks?.length){ const existing=new Set(pl.tasks.map(t=>t.title.trim().toLowerCase())); for(const t of params.tasks){ const norm=t.trim().toLowerCase(); if(!existing.has(norm)){ pl.tasks.push({title:truncate(t),done:false}); existing.add(norm); } } }
        if(params.goal) pl.goal=truncate(params.goal); pl.ts=Date.now(); brain.cachedLatestPlan=pl; brain.needsPlanUpdate=false; await (pi as any).appendEntry?.("brain:plan", pl);
        return {content:[{type:"text",text:truncate(renderPlan(pl)+`\n(id: ${pl.id})`)}],details:{plan:pl}};
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
      const graphCount = brain.deliberations.filter(d=>d.debaters).length;
      const graphLine = brain.deliberations.length ? `Graph: ${brain.deliberations.length} deliberations (${graphCount} debates, ${brain.deliberations.filter(d=>d.parentId).length} branched) — winners:[${brain.deliberations.slice(-3).map(d=>d.winner||"n/a").join(",")}] — replay via recall{query:"think:<id>"}` : "Graph: no deliberations";
      const verboseLine = `Verbose: skip:${brain.stats.skip} auto:${brain.stats.autoEncode} touch:${brain.stats.touch} prune:${brain.stats.prune} trim:${brain.stats.budgetTrim} block:${brain.stats.block} dedup:${brain.stats.dedup} nudge:${brain.stats.nudge} audit:${brain.stats.audit} | ${isVerbose() ? "PI_BRAIN_VERBOSE=1" : "verbose off (set PI_BRAIN_VERBOSE=1)"}`;
      const gistPreview=[...brain.episodes.values()].sort((a,b)=>b.ts-a.ts).slice(0,3).map(gistForEpisode).join(" | "), gistTokens=estTokens(gistPreview);
      const knobs=`Knobs: MAX_BYTES=${MAX_BYTES} MAX_LINES=${MAX_LINES} TAG_BOOST=${TAG_BOOST} HALF_LIFE=${HALF_LIFE_FACTOR}/${HALF_LIFE_DAYS}d REMEMBER_BOOST=${REMEMBER_BOOST} AUTO_BOOST=${AUTO_BOOST} TTL=${AUTO_TTL_MS/86400000}d`;
      const budget=pct!==undefined?`Budget: ${pct}% ${pct>BUDGET_STOP_PCT?"(STOP inject)":pct>BUDGET_WARN_PCT?"(warn: inject 1)":""}`:`Budget: est ${gistTokens} tokens gist`;
      const txt=`Episodes: ${count} (${remCount} remember, ${autoCount} auto)\nTokens: ${usage?.used??"?"} / ${usage?.total??"?"}${pct!==undefined?` (${pct}%)`:""}${overloaded?"\n[overload: consider compaction/pruning]":""}\nDeliberations: ${brain.deliberations.length}\n${idxStats}\n${graphLine}\n${verboseLine}\nGist preview (${gistTokens} tok): ${gistPreview.slice(0,120)}\n${knobs}\n${budget}`;
      return {content:[{type:"text",text:txt}],details:{episodes:count,autoCount,remCount,tokens:usage,recent:[...brain.episodes.values()].slice(-3),overloaded,deliberations:brain.deliberations.slice(-3),index:{tokens:brain.tokenIndex.size,episodes:count,memoHits:brain.memoHits,memoMisses:brain.memoMisses},stats:{...brain.stats, verbose: isVerbose()},knobs:{MAX_BYTES,MAX_LINES,TAG_BOOST,HALF_LIFE_DAYS,HALF_LIFE_FACTOR,REMEMBER_BOOST,AUTO_BOOST}}};
    },
  });
}
