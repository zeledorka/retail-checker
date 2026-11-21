// MOCK MODE ONLY: raw-shape fixtures. Turns the mock game into EXACTLY what the real GET /api/state returns
// (typed against Dev 3's types/game.ts), so the real adapter (adaptState in lib/api.ts) can be exercised without a
// backend. Enabled by the "Raw /api/state shape" toggle in the mock phase switcher.
//
// Deliberately leaves out everything the real backend does NOT return today, so the UI's fallbacks are exercised too:
// no me.roundDelta / me.tokensBefore / me.refunded (-> /play derives the delta from remembered balances), no
// round.betTotals, no leaderboard roundDelta. Verdict extras (overall, strengths, weaknesses, decisiveExchange) are
// kept only when the mock verdict has them (Results: win), so both verdict display paths go through the adapter.
import type { Case, Phase, PublicMessage, PublicRound, PublicVerdict, StateResponse } from "@/types/game";
import type { UiGameState, UiPhase } from "@/lib/types";

const RAW_PHASE: Partial<Record<UiPhase, Phase>> = {
  reveal: "REVEAL", betting: "BETTING", openings: "OPENINGS", debate: "DEBATE",
  judging: "JUDGING", results: "RESULTS", cancelled: "CANCELLED",
};
/** Real phase lengths (lib/game/engine.ts SECONDS) for phases the mock leaves open-ended. */
const REAL_SECONDS: Partial<Record<Phase, number>> = { RESULTS: 10, CANCELLED: 8 };

const iso = (ms: number) => new Date(ms).toISOString();

export function toRawState(ui: UiGameState): StateResponse {
  const now = ui.serverNow;
  const r = ui.round;
  const rawPhase = RAW_PHASE[ui.phase];

  let round: PublicRound | null = null;
  if (r && rawPhase) {
    const started = r.phaseStartedAt ?? now;
    const ends = r.phaseEndsAt ?? started + (REAL_SECONDS[rawPhase] ?? 10) * 1000; // the real backend always has one
    const v = ui.verdict;
    const verdict: PublicVerdict | null = v && v.scores
      ? ({
          winner: v.winner, explanation: v.explanation, summary: v.summary ?? null, scores: v.scores,
          complete: v.complete, turnsCompleted: v.turnsCompleted,
          // Extras only if present (not part of today's PublicVerdict type; the adapter reads them if they appear).
          ...(v.overall ? { overall: v.overall } : {}),
          ...(v.strengths ? { strengths: v.strengths } : {}),
          ...(v.weaknesses ? { weaknesses: v.weaknesses } : {}),
          ...(v.decisiveExchange ? { decisiveExchange: v.decisiveExchange } : {}),
        } as PublicVerdict)
      : null;
    round = {
      id: r.id, roundNumber: r.number, phase: rawPhase,
      phaseStartedAt: iso(started), phaseEndsAt: iso(ends),
      aiStepStatus: r.aiStatus, turnsCompleted: r.turnsCompleted, maxTurns: r.maxTurns,
      winner: ui.phase === "results" ? v?.winner ?? null : null,
      verdict: ui.phase === "results" ? verdict : null,
    };
  }

  const kase: Case | null = ui.case && {
    id: ui.case.id, title: ui.case.title, description: ui.case.description, evidence: ui.case.evidence,
    interpretationA: ui.case.positionA, interpretationB: ui.case.positionB, imageUrl: ui.case.imageUrl,
  };

  const publicMessages: PublicMessage[] = ui.transcript.map((a) => ({
    id: `msg-${a.sequence}`, key: a.key, side: a.side, stage: a.stage, sequence: a.sequence,
    debateTurn: a.debateTurn ?? null, text: a.text, createdAt: iso(now),
  }));

  return {
    version: ui.version,
    serverNow: iso(now),
    game: {
      id: "mock-game",
      status: ui.game.status === "lobby" ? "LOBBY" : ui.game.status === "game_over" ? "GAME_OVER" : "IN_PROGRESS",
      roundNumber: ui.game.roundNumber, maxRounds: ui.game.maxRounds, autopilot: false,
    },
    round,
    case: round ? kase : null,
    publicMessages: round ? publicMessages : [],
    me: ui.me && {
      nickname: ui.me.nickname, tokens: ui.me.tokens, bet: ui.me.bet,
      injection: ui.me.suggestion ? { text: ui.me.suggestion.text } : null,
    },
    leaderboard: ui.leaderboard.map((e) => ({ nickname: e.nickname, tokens: e.tokens, correctPicks: e.correctPicks })),
  };
}
