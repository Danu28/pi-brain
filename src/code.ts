// src/code.ts — P2 code index (dual corpus) — CPU/private, hash-neural-384 only, 0 deps
// Absorbed from Pi-NN fallback (walkFiles/chunkFile/patchFile) — no Xenova, no daemon, offline.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { brain } from "./state";
import { hashNeuralEmbed, cosine } from "./neural";

const DIM = 384;

export type CodeBlock = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  preview: string;
  content: string;
  hash: string;
  embedding: Float32Array;
};

function chunkFile(file: string, content: string): Omit<CodeBlock, "embedding">[] {
  const CHUNK_CHARS = 800;
  const OVERLAP = 120;
  const blocks: Omit<CodeBlock, "embedding">[] = [];
  let offset = 0;
  let chunkIdx = 0;
  while (offset < content.length) {
    const slice = content.slice(offset, offset + CHUNK_CHARS);
    if (slice.trim().length < 20) { offset += CHUNK_CHARS - OVERLAP; continue; }
    const startLine = content.slice(0, offset).split("\n").length;
    const endLine = startLine + slice.split("\n").length - 1;
    const preview = slice.slice(0, 500).replace(/\s+/g, " ").trim();
    const hash = crypto.createHash("sha1").update(slice).digest("hex").slice(0, 8);
    blocks.push({ id: `${file}#${chunkIdx}:${hash}`, file, startLine, endLine, preview, content: slice, hash });
    chunkIdx++;
    if (offset + CHUNK_CHARS >= content.length) break;
    offset += CHUNK_CHARS - OVERLAP;
    const nextNl = content.indexOf("\n", offset);
    if (nextNl !== -1 && nextNl - offset < 80) offset = nextNl + 1;
  }
  if (blocks.length === 0 && content.trim().length >= 10) {
    const hash = crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);
    return [{ id: `${file}#0:${hash}`, file, startLine: 1, endLine: content.split("\n").length, preview: content.slice(0, 500).replace(/\s+/g, " ").trim(), content, hash }];
  }
  return blocks;
}

const IGNORE_DIRS = new Set(["node_modules",".git",".pi","dist","build",".next","coverage","__pycache__",".turbo","model-cache"]);
const BINARY_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp",".mp4",".mp3",".zip",".tar",".gz",".pdf",".exe",".dll",".so",".dylib",".woff",".woff2",".ttf"]);

async function walkFiles(root: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 12) return out;
  let entries: any[];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) { if (IGNORE_DIRS.has(e.name)) continue; }
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) await walkFiles(full, out, depth + 1);
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      try { const st = await fs.stat(full); if (st.size > 300_000 || st.size === 0) continue; } catch { continue; }
      out.push(full);
    }
  }
  return out;
}

async function loadGitignore(cwd: string): Promise<(p: string)=>boolean> {
  try {
    const raw = await fs.readFile(path.join(cwd, ".gitignore"), "utf8");
    const patterns = raw.split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#")).map(l=>l.replace(/\/$/,""));
    return (p:string)=>{ const rel = path.relative(cwd,p).replace(/\\/g,"/"); return patterns.some(pat=>{
      if (pat.includes("*")) { try { const re = new RegExp("^"+pat.replace(/\./g,"\\.").replace(/\*/g,".*")+"$"); return re.test(rel);} catch {return false;}}
      return rel===pat || rel.startsWith(pat+"/");
    });};
  } catch { return ()=>false; }
}

export async function buildCodeIndex(cwd: string, signal?: AbortSignal): Promise<{ took:string; stats:{files:number;blocks:number;model:string}} | null> {
  if (brain.codeIndexing) return null;
  brain.codeIndexing = true;
  const t0 = Date.now();
  try {
    const allFiles = await walkFiles(cwd);
    const isIgnored = await loadGitignore(cwd);
    const files = allFiles.filter(f=>!isIgnored(f));
    const codeExt = new Set([".ts",".js",".tsx",".jsx",".py",".go",".rs",".java",".md"]);
    const prioritized = files.sort((a,b)=>{ const aCode = codeExt.has(path.extname(a))?0:1; const bCode = codeExt.has(path.extname(b))?0:1; return aCode-bCode; });
    const capped = prioritized.slice(0,500);
    const newBlocks: CodeBlock[] = [];
    const newHashes = new Map<string,string>();
    for (const file of capped) {
      if (signal?.aborted) break;
      let content: string; try { content = await fs.readFile(file,"utf8"); } catch { continue; }
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      newHashes.set(file, hash);
      const rel = path.relative(cwd, file);
      const chunks = chunkFile(rel, content);
      for (const b of chunks) {
        const emb = hashNeuralEmbed(b.content);
        (newBlocks as any).push({ ...b, embedding: emb });
      }
    }
    brain.codeBlocks = newBlocks as any;
    brain.codeFileHashes = newHashes;
    brain.codeIndexStats = { files: capped.length, blocks: newBlocks.length, model: "hash-neural-384", lastIndexedAt: Date.now() };
    const took = ((Date.now()-t0)/1000).toFixed(2);
    return { took, stats: { ...brain.codeIndexStats } };
  } finally { brain.codeIndexing = false; }
}

export async function syncCodeIndex(cwd: string, signal?: AbortSignal) {
  if (brain.codeIndexing) return;
  brain.codeIndexing = true;
  try {
    const allFiles = await walkFiles(cwd);
    const isIgnored = await loadGitignore(cwd);
    const files = allFiles.filter(f=>!isIgnored(f)).slice(0,500);
    const relSet = new Set(files.map(f=>path.relative(cwd,f)));
    // remove deleted files (handle both full and rel keys legacy)
    for (const tracked of [...brain.codeFileHashes.keys()]) {
      const rel = tracked.includes(path.sep) ? path.relative(cwd, tracked) : tracked;
      const keyRel = relSet.has(tracked) ? tracked : relSet.has(rel) ? rel : null;
      if (!keyRel) {
        // check if tracked is full path that maps to rel
        const asRel = tracked.includes(path.sep) ? path.relative(cwd, tracked) : tracked;
        if (!relSet.has(asRel) && !relSet.has(tracked)) {
          brain.codeBlocks = brain.codeBlocks.filter(b=>b.file !== tracked && b.file !== asRel);
          brain.codeFileHashes.delete(tracked);
        }
      }
    }
    for (const full of files) {
      if (signal?.aborted) break;
      const rel = path.relative(cwd, full);
      let content: string;
      try { content = await fs.readFile(full,"utf8"); } catch { continue; }
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      const existing = brain.codeFileHashes.get(rel) ?? brain.codeFileHashes.get(full);
      if (existing === hash) continue;
      brain.codeBlocks = brain.codeBlocks.filter(b=>b.file !== rel);
      const chunks = chunkFile(rel, content);
      for (const b of chunks) {
        const emb = hashNeuralEmbed(b.content);
        brain.codeBlocks.push({ ...b, embedding: emb } as CodeBlock);
      }
      brain.codeFileHashes.delete(full);
      brain.codeFileHashes.set(rel, hash);
    }
    brain.codeIndexStats.blocks = brain.codeBlocks.length;
    brain.codeIndexStats.files = brain.codeFileHashes.size;
    brain.codeIndexStats.lastIndexedAt = Date.now();
  } finally { brain.codeIndexing = false; }
}

export async function patchCodeFile(cwd: string, relFile: string) {
  const full = path.join(cwd, relFile);
  let content: string;
  try { content = await fs.readFile(full,"utf8"); } catch {
    // deleted
    brain.codeBlocks = brain.codeBlocks.filter(b=>b.file !== relFile);
    brain.codeFileHashes.delete(relFile);
    brain.codeIndexStats.blocks = brain.codeBlocks.length;
    brain.codeIndexStats.files = brain.codeFileHashes.size;
    return;
  }
  const hash = crypto.createHash("sha1").update(content).digest("hex");
  if (brain.codeFileHashes.get(full) === hash || brain.codeFileHashes.get(relFile) === hash) return;
  brain.codeBlocks = brain.codeBlocks.filter(b=>b.file !== relFile);
  const chunks = chunkFile(relFile, content);
  for (const b of chunks) {
    const emb = hashNeuralEmbed(b.content);
    brain.codeBlocks.push({ ...b, embedding: emb } as CodeBlock);
  }
  brain.codeFileHashes.set(relFile, hash);
  brain.codeIndexStats.blocks = brain.codeBlocks.length;
  brain.codeIndexStats.files = brain.codeFileHashes.size;
  brain.codeIndexStats.lastIndexedAt = Date.now();
}

export function searchCode(query: string, topK = 3, filterPath?: string) {
  if (!brain.codeBlocks.length) return { hits: [] as Array<{ file:string; startLine:number; endLine:number; score:number; preview:string }>, model: "hash-neural-384", totalBlocks: 0 };
  const qEmb = hashNeuralEmbed(query);
  const scored: Array<{ block: CodeBlock; score: number }> = [];
  for (const b of brain.codeBlocks) {
    if (filterPath && !b.file.includes(filterPath)) continue;
    const s = cosine(qEmb, b.embedding);
    const previewLower = b.preview.toLowerCase();
    const qTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let boost = 0; for (const t of qTokens) if (previewLower.includes(t)) boost += 0.02;
    scored.push({ block: b, score: Math.min(1, s + boost) });
  }
  scored.sort((a,b)=>b.score-a.score);
  const hits = scored.slice(0, Math.min(topK,10)).map(({block,score})=>({ file:block.file, startLine:block.startLine, endLine:block.endLine, score: Number(score.toFixed(3)), preview:block.preview.slice(0,500)}));
  return { hits, model: "hash-neural-384", totalBlocks: brain.codeBlocks.length };
}

export function formatCodeHits(query:string, result: ReturnType<typeof searchCode>) {
  if (!result.hits.length) return `🔍 Code — no hits for "${query}" (${result.totalBlocks} blocks)`;
  const lines = [`🔍 Code — "${query}" — Top ${result.hits.length} (of ${result.totalBlocks} blocks, model: ${result.model})`];
  for (let i=0;i<result.hits.length;i++){ const h=result.hits[i]; const bar="█".repeat(Math.round(h.score*10))+"░".repeat(10-Math.round(h.score*10)); lines.push(`${i+1}. ${h.file}:${h.startLine}  ${h.score.toFixed(3)}  ${bar}`); lines.push(`   "${h.preview}"`); }
  let out = lines.join("\n"); if (out.length>4000) out=out.slice(0,4000)+"\n… truncated"; return out;
}
