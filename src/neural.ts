// src/neural.ts — hash-neural-384 (pure JS, 0 deps, CPU <1ms, 100% private)
// Deterministic, no download, no wasm, no network. Air-gap safe.
// Copied from Pi-NN fallback (hashNeuralEmbed) — keep in sync if weights change.
// Seed 42 = stable across versions; changing seed requires re-embed.

import { NEURAL_DIM, NEURAL_SEED } from "./knobs";

export const DIM = NEURAL_DIM; // 384

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let W: Float32Array | null = null;
let B: Float32Array | null = null;

export function getWeights() {
  if (W && B) return { W, B };
  const rand = mulberry32(NEURAL_SEED);
  W = new Float32Array(DIM * DIM);
  B = new Float32Array(DIM);
  const scale = Math.sqrt(2 / (DIM + DIM));
  for (let i = 0; i < DIM * DIM; i++) W[i] = (rand() * 2 - 1) * scale * 0.5;
  for (let i = 0; i < DIM; i++) B[i] = (rand() * 2 - 1) * 0.02;
  return { W, B };
}

export function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// hashNeuralEmbed — deterministic, ~147k muls (<1ms), no deps.
// 1) hash bucket accumulation TF-weighted, 3 spreads + neighbor 0.3
// 2) tiny MLP: tanh(W·vec+B)*0.7 + residual*0.3 → normalize
export function hashNeuralEmbed(text: string): Float32Array {
  const { W, B } = getWeights();
  const vec = new Float32Array(DIM);
  const tokens = text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [tok, count] of tf) {
    const h = hashToken(tok);
    const weight = 1 + Math.log(count);
    for (let k = 0; k < 3; k++) {
      const idx = (h + k * 0x9e3779b9) % DIM;
      const sign = ((h >> (k * 8)) & 1) === 0 ? 1 : -1;
      vec[idx] += sign * weight;
      vec[(idx + 1) % DIM] += sign * weight * 0.3;
    }
  }
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    let sum = B![i];
    const rowOff = i * DIM;
    for (let j = 0; j < DIM; j++) if (vec[j] !== 0) sum += W![rowOff + j] * vec[j];
    out[i] = Math.tanh(sum) * 0.7 + vec[i] * 0.3;
  }
  return l2Normalize(out);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return Math.max(-1, Math.min(1, d));
}

// helpers for persistence (base64 for session file)
export function toBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}
export function fromBase64(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
