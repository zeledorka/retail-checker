// Typed client for every endpoint + the ONE backend -> UI adapter.
// When the backend contract changes, edit `adaptState` (and the Backend* types) here; components never change.
"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApiError, type AdminResult, type ApiErrorCode, type BetResult, type JoinResult, type PublicArgument, type Side,
  type UiGameState, type UiLeaderboardEntry, type UiPhase,
} from "@/lib/types";
import { getPlayerId } from "@/lib/identity";
import * as mock from "@/lib/mock/server";

/** Mock is ON unless NEXT_PUBLIC_USE_MOCK is explicitly "0" (a fresh clone with no .env.local still runs). */
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK !== "0";

// ---------------------------------------------------------------------------------------------------------------------
// Backend shapes. COPY of ai-courtroom/types/game.ts on origin/feat/backend-multiplayer-connection (owned by Dev 3).
// TODO: confirm against backend (it still models the OLD parallel debate; see adaptState notes).
// ---------------------------------------------------------------------------------------------------------------------
type BSide = "A" | "B";
type BPhase = "REVEAL" | "BETTING" | "OPENINGS" | "INJECT_1" | "REBUTTALS" | "INJECT_2" | "FINALS" | "JUDGING" | "RESULTS" | "CANCELLED"
  // Expected sequential-design phase names (not in the backend yet):
  | "DEBATE";
type BStateResponse = {
  version: number;
  serverNow: string;
  game: { id: string; status: "LOBBY" | "IN_PROGRESS" | "GAME_OVER"; roundNumber: number; maxRounds: number };
  round: null | {
    id: string; roundNumber: number; phase: BPhase; phaseStartedAt: string; phaseEndsAt: string;
    aiStepStatus: "idle" | "running" | "done" | "failed";
    winner: BSide | null; rationale: string | null;
    // selectedClues is deliberately NOT read: it contains other players' suggestion texts.
    // Optional sequential-design fields we hope Dev 3 adds (TODO: confirm against backend):
    transcript?: PublicArgument[];
    turnsCompleted?: number; maxTurns?: number;
    verdict?: {
      winner: BSide; explanation: string; summary?: string;
      scores: Record<BSide, { evidence: number; logic: number; rebuttal: number; persuasion: number }>; overall?: Record<BSide, number>;
      strengths?: Record<BSide, string[]>; weaknesses?: Record<BSide, string[]>; decisiveExchange?: { refs: string[]; description: string };
      complete?: boolean; turnsCompleted?: number;
    };
    betTotals?: Record<BSide, { players: number; tokens: number }>;
  };
  case: null | { id: string; scenario: string; imageUrl: string; hypothesisA: string; hypothesisB: string; evidence: string[]; title?: string };
  publicMessages: { id: string; side: BSide; text: string; stage: "opening" | "rebuttal" | "final"; ordinal: number; createdAt: string }[];
  me: null | {
    nickname: string; tokens: number; bet: { side: BSide; stake: number } | null; injections: { window: 1 | 2; text: string }[];
    // Settlement fields we asked Dev 3 for (TODO: confirm against backend; not returned today):
    roundDelta?: number | null; tokensBefore?: number | null; refunded?: boolean;
  };
  leaderboard: { nickname: string; tokens: number; correctPicks: number }[];
};

const PHASE_MAP: Record<BPhase, UiPhase> = {
  REVEAL: "reveal", BETTING: "betting", OPENINGS: "openings",
  INJECT_1: "debate", REBUTTALS: "debate", INJECT_2: "debate", FINALS: "debate", DEBATE: "debate",
  JUDGING: "judging", RESULTS: "results", CANCELLED: "cancelled",
};
const MAX_TURNS = 8;

/** THE adapter. Backend StateResponse -> UiGameState. */
export function adaptState(b: BStateResponse): UiGameState {
  const r = b.round;
  const phase: UiPhase = r ? PHASE_MAP[r.phase] ?? "lobby" : b.game.status === "GAME_OVER" ? "game_over" : "lobby";

  const transcript: PublicArgument[] = r?.transcript
    ? [...r.transcript].sort((x, y) => x.sequence - y.sequence)
    : [...b.publicMessages].sort((x, y) => x.ordinal - y.ordinal).map((m, i) => ({
        roundId: r?.id ?? "", stage: m.stage === "opening" ? "opening" : "turn", sequence: i + 1,
        ...(m.stage !== "opening" ? { debateTurn: i - 1 } : {}), side: m.side, text: m.text, key: m.id,
      }));
  const turnsCompleted = r?.turnsCompleted ?? Math.max(0, transcript.length - 2);
  const maxTurns = r?.maxTurns ?? MAX_TURNS;
  const aiStatus = r?.aiStepStatus ?? "idle";
  const debating = phase === "openings" || phase === "debate";
  const nextSpeaker: Side | null = debating && turnsCompleted < maxTurns && aiStatus !== "done"
    ? (transcript.length % 2 === 0 ? "A" : "B") : null;

  const revealed = phase === "results" && !!r?.winner;
  const verdict = revealed && r
    ? r.verdict
      ? {
          winner: r.verdict.winner, explanation: r.verdict.explanation, summary: r.verdict.summary, scores: r.verdict.scores, overall: r.verdict.overall,
          strengths: r.verdict.strengths, weaknesses: r.verdict.weaknesses, decisiveExchange: r.verdict.decisiveExchange,
          complete: r.verdict.complete ?? true, turnsCompleted: r.verdict.turnsCompleted ?? turnsCompleted, maxTurns,
        }
      : { winner: r.winner!, explanation: r.rationale ?? "", scores: null, complete: true, turnsCompleted, maxTurns } // TODO: backend has no 4-dim scores / complete flag yet
    : null;

  const me = b.me && {
    nickname: b.me.nickname,
    tokens: b.me.tokens,
    bet: b.me.bet,
    suggestion: b.me.injections[0] && b.me.bet ? { side: b.me.bet.side, text: b.me.injections[0].text } : null,
    // Payouts are NEVER computed on the client. Only pass through what the server returns; when it doesn't,
    // /play falls back to (balance now - balance seen before the round), see lib/useRoundBaseline.ts.
    // TODO: confirm with Dev 3 that state returns me.roundDelta / me.tokensBefore / me.refunded.
    roundDelta: b.me.roundDelta ?? null,
    tokensBefore: b.me.tokensBefore ?? null,
    refunded: b.me.refunded ?? (!!b.me.bet && phase === "cancelled"),
  };
  const myName = b.me?.nickname;
  const leaderboard: UiLeaderboardEntry[] = b.leaderboard.map((e) => ({ ...e, isMe: e.nickname === myName }));

  return {
    version: b.version,
    serverNow: Date.parse(b.serverNow),
    game: { status: b.game.status === "LOBBY" ? "lobby" : b.game.status === "GAME_OVER" ? "game_over" : "in_progress", roundNumber: b.game.roundNumber, maxRounds: b.game.maxRounds },
    round: r && {
      id: r.id, number: r.roundNumber, phase, rawPhase: r.phase,
      phaseStartedAt: Date.parse(r.phaseStartedAt) || null, phaseEndsAt: Date.parse(r.phaseEndsAt) || null,
      aiStatus, turnsCompleted, maxTurns, nextSpeaker,
      bettingOpen: r.phase === "BETTING",
      suggestionsOpen: r.phase === "INJECT_1" || r.phase === "INJECT_2" || r.phase === "DEBATE",
      betTotals: r.betTotals ?? null,
    },
    phase,
    case: b.case && {
      id: b.case.id, title: b.case.title ?? "The Case", description: b.case.scenario, evidence: b.case.evidence,
      positionA: b.case.hypothesisA, positionB: b.case.hypothesisB, imageUrl: b.case.imageUrl || null,
    },
    transcript, verdict, me, leaderboard, playerCount: b.leaderboard.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP plumbing (real mode). Player auth = Supabase anonymous session (persisted by supabase-js in localStorage).
// ---------------------------------------------------------------------------------------------------------------------

let supa: SupabaseClient | null = null;
async function client() {
  if (supa) return supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new ApiError("UNKNOWN", "Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY)");
  const { createClient } = await import("@supabase/supabase-js");
  supa = createClient(url, key);
  return supa;
}
/** Returns a bearer token, signing in anonymously if needed. `create=false` = only if a session already exists. */
async function token(create: boolean): Promise<string | null> {
  const c = await client();
  const { data } = await c.auth.getSession();
  if (data.session) return data.session.access_token;
  if (!create) return null;
  const { data: d, error } = await c.auth.signInAnonymously();
  if (error || !d.session) throw new ApiError("UNAUTHENTICATED", "Could not start a session");
  return d.session.access_token;
}
export async function currentUserId(): Promise<string | null> {
  if (USE_MOCK) return getPlayerId();
  const c = await client();
  const { data } = await c.auth.getSession();
  return data.session?.user.id ?? null;
}

const FRIENDLY: Partial<Record<ApiErrorCode, string>> = {
  BETTING_CLOSED: "Betting has closed for this round.",
  ALREADY_BET: "You've already placed a bet this round.",
  INSUFFICIENT_TOKENS: "You don't have enough tokens for that.",
  INJECTION_CLOSED: "Suggestions are closed right now.",
  NO_BET: "Only players who placed a bet can send a suggestion.",
  ALREADY_INJECTED: "You've already sent your suggestion this round.",
  UNAUTHENTICATED: "Your session expired. Please rejoin.",
  NOT_JOINED: "Join the game first.",
  FORBIDDEN: "Wrong admin secret.",
  AI_NOT_DONE: "The AI is still working on this step.",
  NO_CASES_LEFT: "No cases left to play.",
  INTERNAL: "The server hit a problem. Try again.",
  NETWORK: "Can't reach the server. Check your connection.",
};
export const friendly = (e: unknown) =>
  e instanceof ApiError ? FRIENDLY[e.code] ?? e.message : e instanceof Error ? e.message : "Something went wrong";

async function http<T>(path: string, init: RequestInit & { auth?: "required" | "optional" | "none"; admin?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.auth && init.auth !== "none") {
    const t = await token(init.auth === "required");
    if (t) headers.authorization = `Bearer ${t}`;
  }
  if (init.admin) headers["x-admin-secret"] = init.admin;
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("NETWORK", "Network error");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = (body?.error?.code as ApiErrorCode) ?? (res.status === 403 ? "FORBIDDEN" : "UNKNOWN");
    throw new ApiError(code, body?.error?.message ?? body?.error ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------------------------------------------------

/** `asPlayer=false` for the projector (never sends a player token). */
export async function getState(asPlayer: boolean): Promise<UiGameState> {
  if (USE_MOCK) return mock.mockGetState(asPlayer ? getPlayerId() : null);
  return adaptState(await http<BStateResponse>("/api/state", { auth: asPlayer ? "optional" : "none" }));
}

export async function join(nickname: string): Promise<JoinResult> {
  if (USE_MOCK) return mock.mockJoin(getPlayerId(true)!, nickname);
  const r = await http<{ player: { id: string; nickname: string; tokens: number } }>("/api/join", {
    method: "POST", auth: "required", body: JSON.stringify({ nickname }),
  });
  return { nickname: r.player.nickname, tokens: r.player.tokens };
}

export async function placeBet(roundId: string, side: Side, stake: number): Promise<BetResult> {
  if (USE_MOCK) return mock.mockBet(getPlayerId()!, side, stake);
  return http<BetResult>("/api/bet", { method: "POST", auth: "required", body: JSON.stringify({ roundId, side, stake }) });
}

/** One suggestion per round. The side is decided by the server from the player's bet. */
export async function sendSuggestion(roundId: string, rawPhase: string, text: string): Promise<void> {
  if (USE_MOCK) { await mock.mockInject(getPlayerId()!, text); return; }
  // TODO: confirm against backend. Current backend requires `window` (1|2, old parallel design).
  const window = rawPhase === "INJECT_2" ? 2 : 1;
  await http("/api/inject", { method: "POST", auth: "required", body: JSON.stringify({ roundId, window, text }) });
}

export async function getLeaderboard(): Promise<UiLeaderboardEntry[]> {
  if (USE_MOCK) return (await mock.mockGetState(null)).leaderboard;
  return (await http<{ players: UiLeaderboardEntry[] }>("/api/leaderboard")).players;
}

// ---- admin (x-admin-secret header; secret lives in sessionStorage only) ----
export const admin = {
  async start(secret: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminStart();
    await http("/api/admin/start", { method: "POST", admin: secret });
    return { ok: true, detail: "Round started" };
  },
  async advance(secret: string, rawPhase: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminAdvance();
    const r = await http<{ changed: boolean; phase: string | null }>("/api/admin/advance", { method: "POST", admin: secret, body: JSON.stringify({ expectedPhase: rawPhase }) });
    return { ok: true, detail: r.changed ? `Now ${r.phase}` : "No change (already advanced)" };
  },
  async runAi(secret: string, roundId: string, rawPhase: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminRunAi();
    const r = await http<{ status: string }>("/api/admin/run-ai", { method: "POST", admin: secret, body: JSON.stringify({ roundId, expectedPhase: rawPhase }) });
    return { ok: true, detail: `AI: ${r.status}` };
  },
  async cancel(secret: string, roundId: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminCancel();
    const r = await http<{ refunded: number }>("/api/admin/cancel", { method: "POST", admin: secret, body: JSON.stringify({ roundId }) });
    return { ok: true, detail: `Cancelled, ${r.refunded} refunded` };
  },
};
