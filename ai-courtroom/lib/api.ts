// Typed client for every endpoint + the ONE backend -> UI adapter.
// When the backend contract changes, edit `adaptState` here; components never change.
"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApiError, type AdminResult, type ApiErrorCode, type BetResult, type JoinResult, type PublicArgument, type Side,
  type UiGameState, type UiLeaderboardEntry, type UiPhase,
} from "@/lib/types";
import type {
  AdvanceResponse, BetResponse, CancelResponse, JoinResponse, LeaderboardResponse, Phase as BPhase, PublicVerdict,
  ResetResponse, RunAiResponse, StateResponse, TickResponse,
} from "@/types/game";
import { getPlayerId } from "@/lib/identity";
import * as mock from "@/lib/mock/server";

/** Mock is ON unless NEXT_PUBLIC_USE_MOCK is explicitly "0" (a fresh clone with no .env still runs). */
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK !== "0";

// ---------------------------------------------------------------------------------------------------------------------
// Backend contract: Dev 3's types/game.ts is the source of truth (imported, never copied).
// Fields we asked Dev 3 for but that don't exist yet are OPTIONAL extras below: if they appear later the adapter
// prefers them automatically; until then the UI falls back (see lib/useRoundBaseline.ts).
// ---------------------------------------------------------------------------------------------------------------------
/** TODO: ask Dev 3: settlement for the signed-in player (not returned yet). */
type FutureMe = { roundDelta?: number | null; tokensBefore?: number | null; refunded?: boolean };
/** TODO: ask Dev 3: bet split per side for the projector (not returned yet). */
type FutureRound = { betTotals?: Record<Side, { players: number; tokens: number }> | null };
/** TODO: ask Dev 3: the rest of the engine's JudgeVerdict (not returned yet). */
type FutureVerdict = {
  overall?: Record<Side, number>; strengths?: Record<Side, string[]>; weaknesses?: Record<Side, string[]>;
  decisiveExchange?: { refs: string[]; description: string };
};
/** TODO: ask Dev 3: per-player token change this round on the leaderboard (not returned yet). */
type FutureLeader = { roundDelta?: number };

type BMe = NonNullable<StateResponse["me"]> & FutureMe;
type BRound = NonNullable<StateResponse["round"]> & FutureRound;
type BVerdict = PublicVerdict & FutureVerdict;

const PHASE_MAP: Record<BPhase, UiPhase> = {
  REVEAL: "reveal", BETTING: "betting", OPENINGS: "openings", DEBATE: "debate",
  JUDGING: "judging", RESULTS: "results", CANCELLED: "cancelled",
};
const DEFAULT_MAX_TURNS = 8;

/** Dev-only (real mode): warn once per missing field so backend shape drift is obvious in the console. */
const warned = new Set<string>();
function warnDrift(b: StateResponse) {
  if (USE_MOCK || process.env.NODE_ENV === "production") return;
  const miss = (path: string, ok: boolean) => {
    if (ok || warned.has(path)) return;
    warned.add(path);
    console.warn(`[api] /api/state is missing "${path}" (the adapter in lib/api.ts expects it)`);
  };
  const keys = (o: unknown, prefix: string, list: string[]) => {
    const rec = (o ?? {}) as Record<string, unknown>;
    for (const k of list) miss(`${prefix}${k}`, k in rec);
  };
  keys(b, "", ["version", "serverNow", "game", "round", "case", "publicMessages", "me", "leaderboard"]);
  if (b.round) {
    keys(b.round, "round.", ["id", "roundNumber", "phase", "phaseStartedAt", "phaseEndsAt", "aiStepStatus", "turnsCompleted", "maxTurns", "verdict"]);
    miss(`a known round.phase (got "${String(b.round.phase)}")`, b.round.phase in PHASE_MAP);
  }
  if (b.case) keys(b.case, "case.", ["title", "description", "evidence", "interpretationA", "interpretationB", "imageUrl"]);
  if (b.publicMessages?.[0]) keys(b.publicMessages[0], "publicMessages[].", ["key", "side", "stage", "sequence", "text"]);
  if (b.me) keys(b.me, "me.", ["nickname", "tokens", "bet", "injection"]);
  if (b.round?.verdict) keys(b.round.verdict, "round.verdict.", ["winner", "explanation", "scores", "complete", "turnsCompleted"]);
}

/** THE adapter. Backend StateResponse (types/game.ts) -> UiGameState. */
export function adaptState(b: StateResponse): UiGameState {
  warnDrift(b);
  const r = b.round as BRound | null;
  const phase: UiPhase = r ? PHASE_MAP[r.phase] ?? "lobby" : b.game.status === "GAME_OVER" ? "game_over" : "lobby";

  // Transcript ordered by sequence (opening A = 1, opening B = 2, turns 3..10). Speaker and turn come from the data.
  const transcript: PublicArgument[] = [...(b.publicMessages ?? [])]
    .sort((x, y) => x.sequence - y.sequence)
    .map((m) => ({
      roundId: r?.id ?? "",
      stage: m.stage === "opening" ? "opening" : "turn",
      sequence: m.sequence,
      ...(m.debateTurn != null ? { debateTurn: m.debateTurn } : {}),
      side: m.side,
      text: m.text,
      key: m.key || m.id,
    }));
  const maxTurns = r?.maxTurns ?? DEFAULT_MAX_TURNS;
  const turnsCompleted = r?.turnsCompleted ?? transcript.filter((t) => t.stage === "turn").length;
  const aiStatus = r?.aiStepStatus ?? "idle";
  // Next speaker = owner of the next sequence number (odd = A, even = B) while AI work remains in this phase.
  const debating = phase === "openings" || phase === "debate";
  const nextSeq = (transcript.at(-1)?.sequence ?? 0) + 1;
  const remaining = phase === "openings" ? nextSeq <= 2 : nextSeq <= maxTurns + 2;
  const nextSpeaker: Side | null = debating && remaining && aiStatus !== "done" ? (nextSeq % 2 === 1 ? "A" : "B") : null;

  const v = (phase === "results" ? r?.verdict ?? null : null) as BVerdict | null;
  const verdict = v && {
    winner: v.winner,
    explanation: v.explanation,
    ...(v.summary ? { summary: v.summary } : {}),
    scores: v.scores ?? null,
    overall: v.overall,
    strengths: v.strengths,
    weaknesses: v.weaknesses,
    decisiveExchange: v.decisiveExchange,
    complete: v.complete ?? true,
    turnsCompleted: v.turnsCompleted ?? turnsCompleted,
    maxTurns,
  };

  const bm = b.me as BMe | null;
  const me = bm && {
    nickname: bm.nickname,
    tokens: bm.tokens,
    bet: bm.bet ?? null,
    // One clue per round; it goes to the side the player bet on (the server derives it from the bet the same way).
    suggestion: bm.injection?.text && bm.bet ? { side: bm.bet.side, text: bm.injection.text } : null,
    // Payouts are NEVER computed on the client. Prefer server settlement fields if they ever appear; otherwise /play
    // derives the delta from balances it has seen (lib/useRoundBaseline.ts). TODO: ask Dev 3.
    roundDelta: typeof bm.roundDelta === "number" ? bm.roundDelta : null,
    tokensBefore: typeof bm.tokensBefore === "number" ? bm.tokensBefore : null,
    refunded: bm.refunded ?? (!!bm.bet && phase === "cancelled"),
  };
  const myName = bm?.nickname;
  const leaderboard: UiLeaderboardEntry[] = (b.leaderboard ?? []).map((e) => {
    const d = (e as typeof e & FutureLeader).roundDelta;
    return { nickname: e.nickname, tokens: e.tokens, correctPicks: e.correctPicks, isMe: e.nickname === myName, ...(typeof d === "number" ? { roundDelta: d } : {}) };
  });

  return {
    version: b.version,
    serverNow: Date.parse(b.serverNow),
    game: {
      status: b.game.status === "LOBBY" ? "lobby" : b.game.status === "GAME_OVER" ? "game_over" : "in_progress",
      roundNumber: b.game.roundNumber, maxRounds: b.game.maxRounds,
    },
    round: r && {
      id: r.id, number: r.roundNumber, phase, rawPhase: r.phase,
      phaseStartedAt: Date.parse(r.phaseStartedAt) || null, phaseEndsAt: Date.parse(r.phaseEndsAt) || null,
      aiStatus, turnsCompleted, maxTurns, nextSpeaker,
      bettingOpen: r.phase === "BETTING",
      // Clues are accepted during OPENINGS and DEBATE (types/game.ts), one per player per round.
      suggestionsOpen: r.phase === "OPENINGS" || r.phase === "DEBATE",
      betTotals: r.betTotals ?? null,
    },
    phase,
    case: b.case && {
      id: b.case.id, title: b.case.title, description: b.case.description, evidence: b.case.evidence ?? [],
      positionA: b.case.interpretationA, positionB: b.case.interpretationB, imageUrl: b.case.imageUrl || null,
    },
    transcript, verdict, me, leaderboard, playerCount: leaderboard.length,
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
  return adaptState(await http<StateResponse>("/api/state", { auth: asPlayer ? "optional" : "none" }));
}

export async function join(nickname: string): Promise<JoinResult> {
  if (USE_MOCK) return mock.mockJoin(getPlayerId(true)!, nickname);
  const r = await http<JoinResponse>("/api/join", { method: "POST", auth: "required", body: JSON.stringify({ nickname }) });
  return { nickname: r.player.nickname, tokens: r.player.tokens };
}

export async function placeBet(roundId: string, side: Side, stake: number): Promise<BetResult> {
  if (USE_MOCK) return mock.mockBet(getPlayerId()!, side, stake);
  const r = await http<BetResponse>("/api/bet", { method: "POST", auth: "required", body: JSON.stringify({ roundId, side, stake }) });
  return { tokensRemaining: r.tokensRemaining };
}

/** One suggestion per round (max 200 chars). The side is decided by the server from the player's bet. */
export async function sendSuggestion(roundId: string, text: string): Promise<void> {
  if (USE_MOCK) { await mock.mockInject(getPlayerId()!, text); return; }
  await http("/api/inject", { method: "POST", auth: "required", body: JSON.stringify({ roundId, text }) });
}

export async function getLeaderboard(): Promise<UiLeaderboardEntry[]> {
  if (USE_MOCK) return (await mock.mockGetState(null)).leaderboard;
  return (await http<LeaderboardResponse>("/api/leaderboard")).players;
}

// ---- admin (x-admin-secret header; secret lives in sessionStorage only) ----

/** run-ai / tick AI statuses -> a dock toast. "failed" arrives as HTTP 502 and is thrown as an error by the caller. */
function aiToast(ai: RunAiResponse): AdminResult {
  switch (ai.status) {
    case "progress": return { ok: true, kind: "info", detail: "AI working: one step done, more to go" };
    case "done": return { ok: true, kind: "ok", detail: "AI step done for this phase" };
    case "skipped": return { ok: true, kind: "info", detail: "AI skipped (busy elsewhere, or nothing to do)" };
    case "failed": return { ok: true, kind: "error", detail: `AI failed: ${ai.error ?? "unknown error"}` };
  }
}

export const admin = {
  async start(secret: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminStart();
    const r = await http<AdvanceResponse>("/api/admin/start", { method: "POST", admin: secret });
    return { ok: true, detail: r.changed ? `Round started (${r.phase})` : "Already started" };
  },
  async advance(secret: string, rawPhase: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminAdvance();
    const r = await http<AdvanceResponse>("/api/admin/advance", { method: "POST", admin: secret, body: JSON.stringify({ expectedPhase: rawPhase }) });
    return { ok: true, kind: r.changed ? "ok" : "info", detail: r.changed ? `Now ${r.phase ?? "game over"}` : "No change (already advanced)" };
  },
  async runAi(secret: string, roundId: string, rawPhase: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminRunAi();
    try {
      return aiToast(await http<RunAiResponse>("/api/admin/run-ai", { method: "POST", admin: secret, body: JSON.stringify({ roundId, expectedPhase: rawPhase }) }));
    } catch (e) {
      // The route answers a failed step with HTTP 502 + { status: "failed", error }.
      if (e instanceof ApiError && e.status === 502) throw new ApiError("UNKNOWN", `AI failed: ${e.message}`, 502);
      throw e;
    }
  },
  async cancel(secret: string, roundId: string): Promise<AdminResult> {
    if (USE_MOCK) return mock.mockAdminCancel();
    const r = await http<CancelResponse>("/api/admin/cancel", { method: "POST", admin: secret, body: JSON.stringify({ roundId }) });
    return { ok: true, detail: `Cancelled, ${r.refunded} refunded` };
  },
};
