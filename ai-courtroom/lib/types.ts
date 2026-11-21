// UI-facing types. Components consume ONLY these. All backend -> UI mapping lives in lib/api.ts (adapter).
//
// Real AI contract types are imported (type-only) from ai/src/types.ts, which is self-contained.
// PublicArgument / PublicRoundView live in ai/src/round.ts, which imports the Anthropic SDK at runtime, so
// importing it would pull the SDK into this app's type-check. They are MIRRORED below; keep in sync with
// ai/src/round.ts (lines ~65 and ~100).
import type { CriterionScores, JudgeVerdict, Scenario, Side as AiSide } from "@ai/types";

export type Side = AiSide;
export type { CriterionScores, JudgeVerdict, Scenario };

/** MIRROR of ai/src/round.ts `PublicArgument`. */
export type PublicArgument = {
  roundId: string;
  stage: "opening" | "turn";
  /** Position in the public transcript: opening A = 1, opening B = 2, debate turns = 3..10. */
  sequence: number;
  /** 1..8 for stage "turn". */
  debateTurn?: number;
  side: Side;
  /** Max 45 words, enforced by the AI module. */
  text: string;
  key: string;
};

/** MIRROR of ai/src/round.ts `PublicRoundView["status"]`. */
export type AiRoundStatus = "created" | "opening_in_progress" | "debating" | "ready_for_judge" | "judged";

// ---------------------------------------------------------------------------------------------------------------------
// UI model
// ---------------------------------------------------------------------------------------------------------------------

/** One UI phase per screen state. The sequential debate is a single "debate" phase (turns 3..10). */
export type UiPhase = "lobby" | "reveal" | "betting" | "openings" | "debate" | "judging" | "results" | "cancelled" | "game_over";

export type AiStepStatus = "idle" | "running" | "done" | "failed";

export type UiCase = {
  id: string;
  title: string;
  description: string;
  evidence: string[];
  /** Agent A's locked interpretation. */
  positionA: string;
  /** Agent B's locked interpretation. */
  positionB: string;
  imageUrl: string | null;
};

export type UiVerdict = {
  winner: Side;
  explanation: string;
  summary?: string;
  /** Four dimensions 0-10 per agent. null when the backend does not expose them yet. */
  scores: Record<Side, CriterionScores> | null;
  overall?: Record<Side, number>;
  /** Per-side judge notes (JudgeVerdict.strengths / weaknesses). The judge has no per-dimension explanations. */
  strengths?: Record<Side, string[]>;
  weaknesses?: Record<Side, string[]>;
  decisiveExchange?: { refs: string[]; description: string };
  /** false = judged on a partial transcript (debate cut short). */
  complete: boolean;
  turnsCompleted: number;
  maxTurns: number;
};

export type UiBet = { side: Side; stake: number };

export type UiMe = {
  nickname: string;
  tokens: number;
  bet: UiBet | null;
  /** The player's own accepted suggestion this round (one per round). Side = the side they bet on. */
  suggestion: { side: Side; text: string } | null;
  /** SERVER-provided token change this round once settled (+ win, - loss, 0 refunded). null if not exposed / not settled. */
  roundDelta: number | null;
  /** SERVER-provided balance before this round (before the bet). null if not exposed. */
  tokensBefore: number | null;
  refunded: boolean;
};

export type UiLeaderboardEntry = {
  nickname: string; tokens: number; correctPicks: number; isMe?: boolean;
  /** Token change in the current round, only if the server exposes it. TODO: confirm against backend (not returned today). */
  roundDelta?: number;
};

export type UiRound = {
  id: string;
  number: number;
  phase: UiPhase;
  /** Opaque backend phase name; only the host dock sends it back (expectedPhase). */
  rawPhase: string;
  /** Server epoch ms. */
  phaseStartedAt: number | null;
  phaseEndsAt: number | null;
  aiStatus: AiStepStatus;
  turnsCompleted: number;
  maxTurns: number;
  /** Who speaks next while the debate is running (null when nobody). */
  nextSpeaker: Side | null;
  bettingOpen: boolean;
  suggestionsOpen: boolean;
  /** Only if the backend exposes it publicly. TODO: confirm against backend (not exposed today). */
  betTotals: Record<Side, { players: number; tokens: number }> | null;
};

export type UiGameState = {
  version: number;
  /** Server epoch ms at response time. */
  serverNow: number;
  game: { status: "lobby" | "in_progress" | "game_over"; roundNumber: number; maxRounds: number };
  round: UiRound | null;
  /** Convenience: round?.phase, or "lobby"/"game_over" when there is no active round. */
  phase: UiPhase;
  case: UiCase | null;
  transcript: PublicArgument[];
  verdict: UiVerdict | null;
  me: UiMe | null;
  leaderboard: UiLeaderboardEntry[];
  playerCount: number;
};

// ---------------------------------------------------------------------------------------------------------------------
// API results / errors
// ---------------------------------------------------------------------------------------------------------------------

/** Backend error codes (from feat/backend-multiplayer-connection types/game.ts) plus client-side ones. */
export type ApiErrorCode =
  | "UNAUTHENTICATED" | "NOT_JOINED" | "BAD_REQUEST" | "BETTING_CLOSED" | "ALREADY_BET"
  | "INSUFFICIENT_TOKENS" | "INJECTION_CLOSED" | "NO_BET" | "ALREADY_INJECTED"
  | "AI_NOT_DONE" | "NO_CASES_LEFT" | "FORBIDDEN" | "INTERNAL"
  | "NETWORK" | "UNKNOWN";

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message: string, public status = 0) {
    super(message);
  }
}

export type JoinResult = { nickname: string; tokens: number };
export type BetResult = { tokensRemaining: number };
export type AdminResult = { ok: true; detail?: string };
