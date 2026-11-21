// types/game.ts — owned by Dev 3. Do not redefine elsewhere to avoid conflict.
// The AI's own types (AiRoundState, PublicArgument, JudgeVerdict, ...) are NOT redefined here:
// they come from Dev 1's module via `@/lib/ai`. This file is the API contract Dev 2's UI renders.
export type Side = 'A' | 'B';
export type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'GAME_OVER';

/**
 * Round phases (sequential debate, see ai/INTEGRATION.md):
 *   REVEAL -> BETTING -> OPENINGS (A then B) -> DEBATE (8 turns A,B,A,B...) -> JUDGING -> RESULTS
 * Audience clues are accepted during OPENINGS and DEBATE (one per player per round).
 */
export type Phase =
  | 'REVEAL' | 'BETTING' | 'OPENINGS' | 'DEBATE' | 'JUDGING' | 'RESULTS' | 'CANCELLED';
/** idle = AI work remains in this phase; running = a model call is in flight; done = phase's AI work finished. */
export type AiStepStatus = 'idle' | 'running' | 'done' | 'failed';

// ---- Case (public) ----
export type Case = {
  id: string;
  title: string;
  description: string;
  evidence: string[];
  interpretationA: string;   // Agent A's locked position
  interpretationB: string;   // Agent B's locked position
  imageUrl: string | null;   // null = imageless fallback case (never a fabricated URL)
};

// ---- API responses (Dev 2 renders) ----
/** One public argument. sequence: opening A = 1, opening B = 2, turns = 3..10 (debateTurn 1..8). */
export type PublicMessage = {
  id: string;
  key: string;
  side: Side;
  stage: 'opening' | 'turn';
  sequence: number;
  debateTurn: number | null;
  text: string;              // at most 45 words (enforced by the AI module)
  createdAt: string;
};
export type CriterionScores = { evidence: number; logic: number; rebuttal: number; persuasion: number };
export type PublicVerdict = {
  winner: Side;
  explanation: string;
  summary: string | null;
  scores: Record<Side, CriterionScores>;
  complete: boolean;         // false = the clock cut the debate short and the judge ruled on fewer turns
  turnsCompleted: number;
};
export type LeaderboardEntry = { nickname: string; tokens: number; correctPicks: number };
export type PublicRound = {
  id: string; roundNumber: number; phase: Phase;
  phaseStartedAt: string; phaseEndsAt: string;
  aiStepStatus: AiStepStatus;
  turnsCompleted: number;    // debate turns done (0..maxTurns), openings not counted
  maxTurns: number;
  winner: Side | null;       // null until RESULTS
  verdict: PublicVerdict | null; // null until RESULTS
};
export type StateResponse = {
  version: number;
  serverNow: string; // clients compute clock offset; phone clocks drift
  game: { id: string; status: GameStatus; roundNumber: number; maxRounds: number };
  round: PublicRound | null;
  case: Case | null;
  publicMessages: PublicMessage[];
  me: null | {
    nickname: string; tokens: number;
    bet: { side: Side; stake: number } | null;
    injection: { text: string } | null; // this player's one clue for the round
  };
  leaderboard: LeaderboardEntry[];
};
export type JoinResponse = { player: { id: string; nickname: string; tokens: number }; game: StateResponse['game'] };
export type BetResponse = { accepted: true; tokensRemaining: number };
export type InjectResponse = { accepted: true; injectionId: string };
export type AdvanceResponse = { changed: boolean; phase: Phase | null; phaseEndsAt?: string };
export type RunAiResponse = {
  status: 'progress' | 'done' | 'skipped' | 'failed';
  message?: PublicMessage['text'];
  error?: string;
};

export type ErrorCode =
  | 'UNAUTHENTICATED' | 'NOT_JOINED' | 'BAD_REQUEST' | 'BETTING_CLOSED' | 'ALREADY_BET'
  | 'INSUFFICIENT_TOKENS' | 'INJECTION_CLOSED' | 'NO_BET' | 'ALREADY_INJECTED'
  | 'AI_NOT_DONE' | 'NO_CASES_LEFT' | 'FORBIDDEN' | 'INTERNAL';
export type ApiError = { error: { code: ErrorCode; message: string } };
