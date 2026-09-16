// Shared data shapes — brain:episode / brain:plan / brain:deliberation entries.
// Names are Brain*-prefixed to avoid collisions in multi-extension setups.

export type BrainEpisode = {
  id: string;
  cue: string;
  summary: string;
  detail?: string;
  ts: number;
  source: string;
  tags?: string[];
  refs?: string[];
  expiresAt?: number;
  // QDS: relevance at encode time (0-10) — Question: does it matter enough to keep?
  relevance?: number;
};

export type PlanTask = {
  title: string;
  done: boolean;
  refs?: string[];
  check?: string;
  estimate?: string;
  risk?: number;
  depends?: number[];
  relevance?: number;
};
export type BrainPlan = {
  id: string;
  goal: string;
  tasks: PlanTask[];
  ts: number;
  parentId?: string;
  links?: string[]; // episode + think ids
  debateId?: string;
  score?: number;
};

export type Deliberation = {
  id: string;
  goal: string;
  hypotheses: string[];
  conclusion?: string;
  ts: number;
  parentId?: string;
  // enhanced debate graph — set when think runs as debate
  debaters?: { side: string; argues: string; relevance: number; uses: string[] }[];
  rubric?: { a: { cost: number; risk: number; reversibility: number; relevance: number; avg: number }; b: { cost: number; risk: number; reversibility: number; relevance: number; avg: number } };
  winner?: string;
  links?: string[]; // episode ids linked
  score?: number; // overall debate relevance
};