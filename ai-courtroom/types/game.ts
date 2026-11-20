// types/game.ts — owned by Dev 3. Do not redefine elsewhere to avoid conflict. 
export type Side = 'A' | 'B';
export type Stage = 'opening' | 'rebuttal' | 'final';
export type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'GAME_OVER';
export type Phase =
  | 'REVEAL' | 'BETTING' | 'OPENINGS' | 'INJECT_1' | 'REBUTTALS'
  | 'INJECT_2' | 'FINALS' | 'JUDGING' | 'RESULTS' | 'CANCELLED';
export type AiStepStatus = 'idle' | 'running' | 'done' | 'failed';

// ---- AI interface (Dev 1 implements) ----
export type Case = {
  id: string; scenario: string; imageUrl: string;
  hypothesisA: string; hypothesisB: string; evidence: string[];
};
export type AgentLine = { side: Side; text: string; stage: Stage };
export type AudienceClue = { id: string; side: Side; text: string; window: 1 | 2 };
export type Verdict = { winner: Side; rationale: string; scores: { A: number; B: number } };
export type AgentPair = { A: AgentLine; B: AgentLine };

export interface CourtroomAI {
  generateOpening(args: { caseData: Case }): Promise<AgentPair>;
  generatePair(args: {
    caseData: Case; transcript: AgentLine[];
    selectedClues: { A: AudienceClue[]; B: AudienceClue[] };
    stage: 'rebuttal' | 'final';
  }): Promise<AgentPair>;
  judge(args: { caseData: Case; transcript: AgentLine[] }): Promise<Verdict>;
}

// ---- API responses (Dev 2 renders) ----
export type PublicMessage = AgentLine & { id: string; ordinal: number; createdAt: string };
export type LeaderboardEntry = { nickname: string; tokens: number; correctPicks: number };
export type PublicRound = {
  id: string; roundNumber: number; phase: Phase;
  phaseStartedAt: string; phaseEndsAt: string;
  aiStepStatus: AiStepStatus;
  selectedClues: { A: AudienceClue[]; B: AudienceClue[] }; // only after a window is locked
  winner: Side | null;      // null until RESULTS
  rationale: string | null; // null until RESULTS
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
    injections: { window: 1 | 2; text: string }[];
  };
  leaderboard: LeaderboardEntry[];
};
export type JoinResponse = { player: { id: string; nickname: string; tokens: number }; game: StateResponse['game'] };
export type BetResponse = { accepted: true; tokensRemaining: number };
export type InjectResponse = { accepted: true; injectionId: string };
export type AdvanceResponse = { changed: boolean; phase: Phase | null; phaseEndsAt?: string };

export type ErrorCode =
  | 'UNAUTHENTICATED' | 'NOT_JOINED' | 'BAD_REQUEST' | 'BETTING_CLOSED' | 'ALREADY_BET'
  | 'INSUFFICIENT_TOKENS' | 'INJECTION_CLOSED' | 'NO_BET' | 'ALREADY_INJECTED'
  | 'AI_NOT_DONE' | 'NO_CASES_LEFT' | 'FORBIDDEN' | 'INTERNAL';
export type ApiError = { error: { code: ErrorCode; message: string } };