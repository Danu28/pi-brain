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

export type BrainPlan = {
  id: string;
  goal: string;
  tasks: { title: string; done: boolean }[];
  ts: number;
};

export type Deliberation = {
  goal: string;
  hypotheses: string[];
  conclusion?: string;
  ts: number;
};