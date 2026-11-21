// MOCK MODE "server". Runs in the browser, persists to localStorage so every tab (player + projector) sees the same game
// and refreshes restore. The whole round is derived from one timestamp (t0), so tabs never disagree.
// A simulated server-clock skew is applied so the client offset logic is exercised for real.
import {
  ApiError, type PublicArgument, type Side, type UiGameState, type UiPhase, type UiRound, type UiVerdict,
} from "@/lib/types";
import { MOCK_BOTS, MOCK_IMAGE_URL, MOCK_LINES, MOCK_ROUND_ID, MOCK_SCENARIO, MOCK_VERDICT } from "./fixtures";

const KEY = "aic:mock:v1";
/** Simulated server clock is 3.2s ahead of the device clock. */
export const MOCK_SKEW_MS = 3200;
const START_TOKENS = 100;

// Timeline in seconds from round start (planning targets from the spec).
export const T = { reveal: 0, betting: 8, openings: 23, debate: 33, suggestionsClose: 75, judging: 83, results: 103 } as const;
/** When each public argument (sequence 1..10) appears. */
const LINE_AT = [26, 31, 37, 42.5, 48, 53.5, 59, 64.5, 70, 75.5];
const MAX_TURNS = 8;
const INCOMPLETE_TURNS = 4; // the "debate cut short" fixture ends after 4 debate turns
const JUDGE_DONE_AT = 100;

type MockPlayer = {
  nickname: string;
  tokens: number;
  round: number; // which round bet/suggestion belong to
  bet: { side: Side; stake: number } | null;
  suggestion: { side: Side; text: string } | null;
  settledRound: number; // last round whose payout/refund was applied
  delta: number | null;
  refunded: boolean;
  /** Balance before this round's bet (what the real server should expose as me.tokensBefore). */
  before?: number | null;
};

type MockStore = {
  t0: number | null; // sim-server ms; null = lobby
  roundNumber: number;
  variant: "normal" | "incomplete";
  cancelledAt: number | null;
  frozenElapsed: number | null; // seconds; set = clock paused at this point
  winner: Side;
  netFail: boolean;
  players: Record<string, MockPlayer>;
};

const fresh = (): MockStore => ({
  t0: null, roundNumber: 0, variant: "normal", cancelledAt: null, frozenElapsed: null, winner: "A", netFail: false, players: {},
});

export const simNow = () => Date.now() + MOCK_SKEW_MS;

function load(): MockStore {
  if (typeof window === "undefined") return fresh();
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...fresh(), ...(JSON.parse(raw) as MockStore) } : fresh();
  } catch {
    return fresh();
  }
}
function save(s: MockStore) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

const elapsedOf = (s: MockStore, now: number) => (s.t0 === null ? 0 : s.frozenElapsed ?? (now - s.t0) / 1000);

function phaseAt(s: MockStore, e: number): UiPhase {
  if (s.t0 === null) return "lobby";
  if (s.cancelledAt !== null) return "cancelled";
  if (e < T.betting) return "reveal";
  if (e < T.openings) return "betting";
  if (e < T.debate) return "openings";
  if (e < T.judging) return "debate";
  if (e < T.results) return "judging";
  return "results";
}

const PHASE_BOUNDS: Partial<Record<UiPhase, [number, number | null]>> = {
  reveal: [T.reveal, T.betting], betting: [T.betting, T.openings], openings: [T.openings, T.debate],
  debate: [T.debate, T.judging], judging: [T.judging, T.results], results: [T.results, null],
};

function linesVisible(s: MockStore, e: number) {
  const cap = s.variant === "incomplete" ? 2 + INCOMPLETE_TURNS : MOCK_LINES.length;
  return Math.min(cap, LINE_AT.filter((t) => e >= t).length);
}

/** Apply payouts / refunds once per player per round (idempotent, like settle_round / cancel_round). */
function settle(s: MockStore, phase: UiPhase): boolean {
  if (phase !== "results" && phase !== "cancelled") return false;
  let changed = false;
  for (const p of Object.values(s.players)) {
    if (p.settledRound === s.roundNumber) continue;
    p.settledRound = s.roundNumber;
    changed = true;
    if (!p.bet || p.round !== s.roundNumber) { p.delta = null; p.refunded = false; continue; }
    if (phase === "cancelled") { p.tokens += p.bet.stake; p.delta = 0; p.refunded = true; }
    else if (p.bet.side === s.winner) { p.tokens += p.bet.stake * 2; p.delta = p.bet.stake; p.refunded = false; }
    else { p.delta = -p.bet.stake; p.refunded = false; }
  }
  return changed;
}

function buildState(s: MockStore, playerId: string | null, now: number): UiGameState {
  const e = elapsedOf(s, now);
  const phase = phaseAt(s, e);
  const n = phase === "lobby" ? 0 : linesVisible(s, e);
  const transcript: PublicArgument[] = MOCK_LINES.slice(0, n).map((l, i) => ({
    roundId: MOCK_ROUND_ID, stage: i < 2 ? "opening" : "turn", sequence: i + 1,
    ...(i >= 2 ? { debateTurn: i - 1 } : {}), side: l.side, text: l.text,
    key: `${MOCK_ROUND_ID}:${i < 2 ? `opening:${l.side}` : `turn${i + 1}:${l.side}`}`,
  }));
  const turnsCompleted = Math.max(0, n - 2);
  const cap = s.variant === "incomplete" ? 2 + INCOMPLETE_TURNS : MOCK_LINES.length;
  const pending = (phase === "openings" || phase === "debate") && n < cap;
  const t0 = s.t0 ?? now;
  const bounds = PHASE_BOUNDS[phase];
  // When frozen, keep deadlines "ahead" of now so the countdown displays the frozen remaining time.
  const base = s.frozenElapsed !== null ? now - s.frozenElapsed * 1000 : t0;

  let round: UiRound | null = null;
  if (s.t0 !== null) {
    round = {
      id: MOCK_ROUND_ID, number: s.roundNumber, phase, rawPhase: phase.toUpperCase(),
      phaseStartedAt: phase === "cancelled" ? s.cancelledAt : bounds ? base + bounds[0] * 1000 : null,
      phaseEndsAt: phase === "cancelled" ? null : bounds?.[1] != null ? base + bounds[1] * 1000 : null,
      aiStatus: pending ? "running" : phase === "judging" ? (e < JUDGE_DONE_AT ? "running" : "done") : "done",
      turnsCompleted, maxTurns: MAX_TURNS,
      nextSpeaker: pending ? MOCK_LINES[n].side : null,
      bettingOpen: phase === "betting",
      // Same rule as the real backend: clues accepted during OPENINGS and DEBATE.
      suggestionsOpen: (phase === "openings" || phase === "debate") && e < T.suggestionsClose,
      betTotals: totals(s),
    };
  }

  const v = MOCK_VERDICT[s.winner];
  const verdict: UiVerdict | null = phase === "results"
    ? {
        winner: v.winner, explanation: v.explanation, summary: v.summary, scores: v.scores, overall: v.overall,
        strengths: v.strengths, weaknesses: v.weaknesses, decisiveExchange: v.decisiveExchange,
        complete: s.variant !== "incomplete", turnsCompleted, maxTurns: MAX_TURNS,
      }
    : null;

  const p = playerId ? s.players[playerId] : undefined;
  const current = p && p.round === s.roundNumber;
  const me = p
    ? {
        nickname: p.nickname, tokens: p.tokens,
        bet: current ? p.bet : null, suggestion: current ? p.suggestion : null,
        roundDelta: current && p.settledRound === s.roundNumber ? p.delta : null,
        tokensBefore: current && p.bet ? p.before ?? null : null,
        refunded: !!(current && p.refunded),
      }
    : null;

  // Per-round deltas once settled (results) so the projector podium can show them; bots settle like players do.
  const settled = phase === "results";
  const humans = Object.entries(s.players).map(([id, x]) => {
    const d = settled && x.round === s.roundNumber && x.settledRound === s.roundNumber && x.delta !== null ? x.delta : undefined;
    return { nickname: x.nickname, tokens: x.tokens, correctPicks: 0, isMe: id === playerId, ...(d !== undefined ? { roundDelta: d } : {}) };
  });
  const bots = MOCK_BOTS.map((b) => {
    const d = b.side === s.winner ? b.stake : -b.stake;
    return settled
      ? { nickname: b.nickname, tokens: b.tokens + d, correctPicks: b.correctPicks + (d > 0 ? 1 : 0), roundDelta: d }
      : { nickname: b.nickname, tokens: b.tokens, correctPicks: b.correctPicks };
  });
  const leaderboard = [...bots, ...humans]
    .sort((a, b) => b.tokens - a.tokens || b.correctPicks - a.correctPicks);

  return {
    version: Math.floor(e),
    serverNow: now,
    game: { status: s.t0 === null ? "lobby" : "in_progress", roundNumber: s.roundNumber, maxRounds: 5 },
    round, phase,
    case: s.t0 === null ? null : {
      id: "mock-case", title: MOCK_SCENARIO.title, description: MOCK_SCENARIO.description, evidence: MOCK_SCENARIO.evidence,
      positionA: MOCK_SCENARIO.interpretationA, positionB: MOCK_SCENARIO.interpretationB, imageUrl: MOCK_IMAGE_URL,
    },
    transcript, verdict, me, leaderboard, playerCount: leaderboard.length,
  };
}

function totals(s: MockStore) {
  const t = { A: { players: 0, tokens: 0 }, B: { players: 0, tokens: 0 } };
  for (const b of MOCK_BOTS) { t[b.side].players++; t[b.side].tokens += b.stake; }
  for (const p of Object.values(s.players)) if (p.bet && p.round === s.roundNumber) { t[p.bet.side].players++; t[p.bet.side].tokens += p.bet.stake; }
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------
// Public mock API (mirrors lib/api.ts)
// ---------------------------------------------------------------------------------------------------------------------

const delay = (min = 150, max = 450) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

function read(playerId: string | null) {
  const s = load();
  const now = simNow();
  if (settle(s, phaseAt(s, elapsedOf(s, now)))) save(s);
  return { s, now, state: buildState(s, playerId, now) };
}

export async function mockGetState(playerId: string | null): Promise<UiGameState> {
  await delay(60, 200);
  const { s, state } = read(playerId);
  if (s.netFail) throw new ApiError("NETWORK", "Can't reach the courtroom (simulated network error)");
  return state;
}

export async function mockJoin(playerId: string, nickname: string) {
  await delay();
  const name = nickname.trim();
  if (!name) throw new ApiError("BAD_REQUEST", "Nickname required", 400);
  if (name.length > 20) throw new ApiError("BAD_REQUEST", "Max 20 characters", 400);
  const s = load();
  const existing = s.players[playerId];
  s.players[playerId] = existing
    ? { ...existing, nickname: name }
    : { nickname: name, tokens: START_TOKENS, round: s.roundNumber, bet: null, suggestion: null, settledRound: -1, delta: null, refunded: false };
  save(s);
  return { nickname: name, tokens: s.players[playerId].tokens };
}

export async function mockBet(playerId: string, side: Side, stake: number) {
  await delay();
  const { s, state } = read(playerId);
  const p = s.players[playerId];
  if (!p) throw new ApiError("NOT_JOINED", "Join the game first", 401);
  if (!Number.isInteger(stake) || stake <= 0) throw new ApiError("BAD_REQUEST", "Stake must be a whole number above 0", 400);
  if (!state.round?.bettingOpen || simNow() > (state.round.phaseEndsAt ?? 0)) throw new ApiError("BETTING_CLOSED", "Betting is closed", 409);
  if (p.round === s.roundNumber && p.bet) throw new ApiError("ALREADY_BET", "You already placed a bet", 409);
  if (stake > p.tokens) throw new ApiError("INSUFFICIENT_TOKENS", "Not enough tokens", 409);
  p.before = p.tokens;
  p.tokens -= stake;
  p.round = s.roundNumber;
  p.bet = { side, stake };
  p.suggestion = null;
  save(s);
  return { tokensRemaining: p.tokens };
}

export async function mockInject(playerId: string, text: string) {
  await delay();
  const { s, state } = read(playerId);
  const p = s.players[playerId];
  const t = text.trim();
  if (!p) throw new ApiError("NOT_JOINED", "Join the game first", 401);
  if (!t || t.length > 200) throw new ApiError("BAD_REQUEST", "Suggestion must be 1-200 characters", 400);
  if (!state.round?.suggestionsOpen) throw new ApiError("INJECTION_CLOSED", "Suggestions are closed", 409);
  if (!p.bet || p.round !== s.roundNumber) throw new ApiError("NO_BET", "Only players with a bet can send suggestions", 409);
  if (p.suggestion) throw new ApiError("ALREADY_INJECTED", "You already sent your suggestion this round", 409);
  p.suggestion = { side: p.bet.side, text: t };
  save(s);
  return { accepted: true as const };
}

// ---- host / admin ----

function startRound(s: MockStore) {
  s.t0 = simNow();
  s.roundNumber += 1;
  s.variant = "normal";
  s.cancelledAt = null;
  s.frozenElapsed = null;
  s.winner = Math.random() < 0.5 ? "A" : "B";
}

function jumpTo(s: MockStore, seconds: number, keepFrozen = true) {
  if (s.t0 === null) startRound(s);
  if (s.frozenElapsed !== null && keepFrozen) s.frozenElapsed = seconds;
  else { s.frozenElapsed = null; s.t0 = simNow() - seconds * 1000; }
}

export async function mockAdminStart() {
  await delay(300, 700);
  const s = load();
  startRound(s);
  save(s);
  return { ok: true as const, detail: `Round ${s.roundNumber} started` };
}

export async function mockAdminAdvance() {
  await delay(300, 700);
  const s = load();
  const phase = phaseAt(s, elapsedOf(s, simNow()));
  if (phase === "lobby" || phase === "results" || phase === "cancelled") { startRound(s); save(s); return { ok: true as const, detail: "Next round" }; }
  const end = PHASE_BOUNDS[phase]?.[1];
  if (end != null) jumpTo(s, end);
  save(s);
  return { ok: true as const, detail: `Advanced from ${phase}` };
}

export async function mockAdminRunAi() {
  await delay(1500, 2500); // AI is slow: lets you test that the button can't double-fire
  const s = load();
  const e = elapsedOf(s, simNow());
  const next = LINE_AT.find((t) => t > e);
  const phase = phaseAt(s, e);
  if ((phase === "openings" || phase === "debate") && next !== undefined) { jumpTo(s, next); save(s); return { ok: true as const, detail: "AI step done" }; }
  if (phase === "judging") { jumpTo(s, JUDGE_DONE_AT); save(s); return { ok: true as const, detail: "Judge done" }; }
  return { ok: true as const, detail: "Nothing to run (skipped)" };
}

export async function mockAdminCancel() {
  await delay(300, 700);
  const s = load();
  if (s.t0 === null) throw new ApiError("BAD_REQUEST", "No round to cancel", 400);
  if (s.cancelledAt === null) s.cancelledAt = simNow();
  save(s);
  return { ok: true as const, detail: "Round cancelled, bets refunded" };
}

// ---- phase switcher (mock only) ----

export type MockPreset =
  | "lobby" | "reveal" | "betting" | "openings" | "debate-2" | "debate-5" | "debate-8"
  | "judging" | "results-win" | "results-lose" | "results-nobet" | "incomplete" | "cancelled";

export const MOCK_PRESETS: { id: MockPreset; label: string }[] = [
  { id: "lobby", label: "Lobby" }, { id: "reveal", label: "Case reveal" }, { id: "betting", label: "Betting" },
  { id: "openings", label: "Openings" }, { id: "debate-2", label: "Debate T2" }, { id: "debate-5", label: "Debate T5" },
  { id: "debate-8", label: "Debate T8" }, { id: "judging", label: "Judging" }, { id: "results-win", label: "Results: win" },
  { id: "results-lose", label: "Results: lose" },
  { id: "results-nobet", label: "Results: no bet" }, { id: "incomplete", label: "Incomplete verdict" }, { id: "cancelled", label: "Cancelled" },
];

/** Players without a bet get one, so win/lose screens have something to show. */
function ensureBets(s: MockStore) {
  for (const p of Object.values(s.players)) {
    if (p.round === s.roundNumber && p.bet) continue;
    const stake = Math.min(25, p.tokens);
    if (stake <= 0) continue;
    p.before = p.tokens;
    p.tokens -= stake; p.round = s.roundNumber; p.bet = { side: "A", stake }; p.suggestion = null; p.settledRound = s.roundNumber - 1;
  }
}
function majoritySide(s: MockStore): Side {
  let a = 0, b = 0;
  for (const p of Object.values(s.players)) if (p.bet && p.round === s.roundNumber) (p.bet.side === "A" ? a++ : b++);
  return b > a ? "B" : "A";
}

export function mockApplyPreset(preset: MockPreset, freeze: boolean) {
  let s = load();
  if (preset === "lobby") {
    const players = s.players;
    s = { ...fresh(), roundNumber: s.roundNumber, players };
    for (const p of Object.values(players)) { p.bet = null; p.suggestion = null; p.delta = null; p.refunded = false; }
    save(s);
    return;
  }
  // A new round for every jump backwards keeps bets/settlement consistent.
  // "results-nobet" always gets a fresh round so nobody has a bet in it (late joiner / spectator view).
  const needsNewRound = preset === "results-nobet" || s.t0 === null || s.cancelledAt !== null || phaseAt(s, elapsedOf(s, simNow())) === "results";
  if (needsNewRound) startRound(s);
  s.variant = preset === "incomplete" ? "incomplete" : "normal";
  s.frozenElapsed = freeze ? 0 : null;
  const at: Record<Exclude<MockPreset, "lobby">, number> = {
    reveal: 1, betting: T.betting + 0.5, openings: T.openings + 0.5, "debate-2": 43, "debate-5": 60, "debate-8": 77,
    judging: T.judging + 1, "results-win": T.results + 0.2, "results-lose": T.results + 0.2, "results-nobet": T.results + 0.2, incomplete: T.results + 0.2, cancelled: 50,
  };
  if (preset === "results-win" || preset === "results-lose" || preset === "incomplete" || preset === "cancelled") ensureBets(s);
  if (preset === "results-win" || preset === "incomplete") s.winner = majoritySide(s);
  if (preset === "results-lose") s.winner = majoritySide(s) === "A" ? "B" : "A";
  jumpTo(s, at[preset], freeze);
  if (preset === "cancelled") s.cancelledAt = simNow();
  save(s);
}

export function mockSetFrozen(freeze: boolean) {
  const s = load();
  const e = elapsedOf(s, simNow());
  if (freeze) s.frozenElapsed = e;
  else if (s.frozenElapsed !== null) { s.t0 = simNow() - s.frozenElapsed * 1000; s.frozenElapsed = null; }
  save(s);
}
export function mockIsFrozen() { return load().frozenElapsed !== null; }
export function mockSetNetFail(v: boolean) { const s = load(); s.netFail = v; save(s); }
export function mockIsNetFail() { return load().netFail; }
export function mockReset() { localStorage.removeItem(KEY); }
