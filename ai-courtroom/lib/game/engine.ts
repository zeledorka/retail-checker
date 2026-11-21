// Server-only: this file calls the AI (API keys) and uses the secret DB key.
//
// The round, with Dev 1's sequential engine (ai/INTEGRATION.md):
//   REVEAL -> BETTING -> OPENINGS (A, then B) -> DEBATE (8 turns: A,B,A,B,...) -> JUDGING -> RESULTS
//
// Golden rule for every AI call: ONE model call per server invocation, and it is committed to the DB before anything
// is shown. Each call: claim the round's lease -> load AiRoundState -> call ONE engine function -> save the new state
// with compare-and-swap on `revision` (plus the public line/verdict, in the same transaction) -> release.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/supabase/admin';
import {
  getAi, parseRoundState, serializeRound, startRound,
  type AiError, type AiRoundState, type AudienceSubmission, type PublicArgument, type Scenario,
} from '@/lib/ai';
import { getActiveGame } from '@/lib/game/state';
import { GameError } from '@/lib/game/errors';
import { MAX_TURNS } from '@/lib/game/constants';
import type { AdvanceResponse, Phase, RunAiResponse, Side } from '@/types/game';

/* ==========================================================================================
 * 1. CONFIGURATION: the shape of a round. Change timings here, nowhere else.
 * ======================================================================================== */

// Every phase as a RUNTIME list (Zod in the routes needs real values). `as const` keeps the literals.
export const ALL_PHASES = [
  'REVEAL', 'BETTING', 'OPENINGS', 'DEBATE', 'JUDGING', 'RESULTS', 'CANCELLED',
] as const;

// Which phase follows which. RESULTS/CANCELLED have no entry: after them we start a NEW round.
export const NEXT: Partial<Record<Phase, Phase>> = {
  REVEAL: 'BETTING',
  BETTING: 'OPENINGS',
  OPENINGS: 'DEBATE',
  DEBATE: 'JUDGING',
  JUDGING: 'RESULTS',
};

// Phase length in seconds. For AI phases this is a BUDGET, not a promise:
//  - OPENINGS: minimum time on screen (also the first window for audience clues). Never left before both openings exist.
//  - DEBATE:   the AI budget for the 8 turns (~30s measured live). When it runs out we stop asking for turns and judge
//              whatever exists (the judge supports partial debates).
//  - JUDGING:  the judge call (~6s measured; the judge's own timeout is 40s).
export const SECONDS: Record<Phase, number> = {
  REVEAL: 8, BETTING: 15, OPENINGS: 12, DEBATE: 60, JUDGING: 45, RESULTS: 10, CANCELLED: 8,
};

export { MAX_TURNS };
export const AI_PHASES: readonly Phase[] = ['OPENINGS', 'DEBATE', 'JUDGING'];
const isAiPhase = (p: Phase) => AI_PHASES.includes(p);

const AGENT_TIMEOUT_MS = 25_000;   // one opening / one turn
const JUDGE_TIMEOUT_MS = 40_000;
const MIN_TURN_MS = 4_000;         // don't START a debate turn with less than this left in the DEBATE budget
const LEASE_SECONDS = 50;          // > the longest single call; a crashed request's lease expires after this
const MAX_AI_FAILURES = 3;         // autopilot retries a failing step this many times, then cancels (refund) / pauses

/* ==========================================================================================
 * 2. DATABASE ROWS + small loaders
 * ======================================================================================== */

type RoundRow = {
  id: string;
  case_id: string;
  phase: Phase;
  phase_ends_at: string;
  ai_step_status: 'idle' | 'running' | 'done' | 'failed';
  ai_failures: number;
  ai_error_retryable: boolean;
};

async function getRound(roundId: string): Promise<RoundRow> {
  const { data, error } = await db.from('rounds').select('*').eq('id', roundId).single();
  if (error || !data) throw new GameError('BAD_REQUEST', 404, 'Round not found');
  return data as RoundRow;
}

/** The case as the AI's Scenario (the exact startRound input). */
async function loadScenario(caseId: string): Promise<Scenario> {
  const { data: c, error } = await db.from('cases').select('*').eq('id', caseId).single();
  if (error || !c) throw new Error(`Case ${caseId} missing`);
  return {
    title: c.title, description: c.description, evidence: c.evidence_json,
    interpretationA: c.interpretation_a, interpretationB: c.interpretation_b,
  };
}

/**
 * ALL audience clues of the round, in the AI's AudienceSubmission shape. The cumulative list is passed on every turn
 * (ids already in the AI state are ignored). playerId comes from the authenticated session when the clue was stored.
 */
async function loadSubmissions(roundId: string): Promise<AudienceSubmission[]> {
  const { data, error } = await db
    .from('injections')
    .select('id, player_id, side, text, created_at')
    .eq('round_id', roundId)
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((i) => ({
    id: i.id, playerId: i.player_id, side: i.side as Side, text: i.text, submittedAt: i.created_at,
  }));
}

/* ==========================================================================================
 * 3. GAME ACTIONS (called by the admin routes)
 * ======================================================================================== */

/** Start round 1. Safe to double-click: the second call sees the game is no longer in LOBBY. */
export async function startGame(): Promise<AdvanceResponse> {
  const game = await getActiveGame();
  if (game.status !== 'LOBBY') return { changed: false, phase: null };
  return startNextRound(game.id, game.round_number);
}

/**
 * Create the next round (or end the game after max_rounds), then create its AI state.
 * `expectedRoundNumber` makes it idempotent: two simultaneous calls can't create two rounds.
 */
async function startNextRound(gameId: string, expectedRoundNumber: number): Promise<AdvanceResponse> {
  const { data, error } = await db.rpc('start_next_round', {
    p_game: gameId,
    p_expected_round_number: expectedRoundNumber,
    p_reveal_seconds: SECONDS.REVEAL,
  });
  if (error) throw error;                       // e.g. NO_CASES_LEFT → toErrorResponse maps it
  const newRound = data?.[0];                   // SQL returns 0 or 1 rows
  if (newRound) {
    await createAiState(newRound.id, newRound.case_id);
    return { changed: true, phase: newRound.phase, phaseEndsAt: newRound.phase_ends_at };
  }

  // No new round: either someone else already started it, or the game just ended.
  const after = await getActiveGame();
  return { changed: after.status === 'GAME_OVER', phase: null };
}

/**
 * startRound() validates the scenario and returns revision 0 of the AI state. Stored once per round
 * (insert ... on conflict do nothing: never recreate an existing round's state). An invalid case cancels the round.
 */
async function createAiState(roundId: string, caseId: string) {
  const scenario = await loadScenario(caseId);
  const started = startRound({ roundId, scenario, maxTurns: MAX_TURNS });
  if (!started.ok) {
    await db.rpc('cancel_round', { p_round: roundId });
    throw new GameError('BAD_REQUEST', 500, `Case ${caseId} rejected by the AI engine: ${started.error.message}`);
  }
  const { error } = await db.from('ai_round_states').upsert(
    { round_id: roundId, state: JSON.parse(serializeRound(started.state)), revision: started.state.revision },
    { onConflict: 'round_id', ignoreDuplicates: true },
  );
  if (error) throw error;
}

/**
 * Move the current round from `expected` to the next phase.
 * The caller says which phase it THINKS we're in. If that's stale, nothing happens
 * ("host clicks advance twice → phase changes once").
 */
export async function advance(expected: Phase): Promise<AdvanceResponse> {
  const game = await getActiveGame();
  if (game.status === 'GAME_OVER') return { changed: false, phase: null };
  if (!game.current_round_id) throw new GameError('BAD_REQUEST', 409, 'Game not started — call /api/admin/start');

  const round = await getRound(game.current_round_id);
  if (round.phase !== expected) return { changed: false, phase: round.phase };

  // End of a round → start the next one (or finish the game).
  if (expected === 'RESULTS' || expected === 'CANCELLED') {
    return startNextRound(game.id, game.round_number);
  }

  // OPENINGS can't end without both openings; JUDGING can't end without a stored verdict.
  // DEBATE may end early (host or clock): the judge rules on the turns that exist.
  if ((expected === 'OPENINGS' || expected === 'JUDGING') && round.ai_step_status !== 'done') {
    throw new GameError('AI_NOT_DONE', 409, `AI step is "${round.ai_step_status}"`);
  }

  const next = NEXT[expected]!;

  // Pay winners BEFORE the phase flips to RESULTS, so balances are correct the moment players see it.
  // settle_round is idempotent (settled_at) and reads the verdict stored once by commit_ai_step.
  if (next === 'RESULTS') {
    const { error } = await db.rpc('settle_round', { p_round: round.id });
    if (error) throw error;
  }

  const { data: rows, error } = await db.rpc('transition_phase', {
    p_round: round.id, p_expected: expected, p_next: next, p_seconds: SECONDS[next],
  });
  if (error) throw error;
  if (!rows?.length) return { changed: false, phase: expected }; // lost a race; someone else advanced

  // Entering an AI phase → make the FIRST call now (awaited: on Vercel, work after the response may be frozen).
  // The rest is driven by tick() / run-ai, one call per invocation. A failure is recorded on the round, not thrown.
  if (isAiPhase(next)) {
    await runAiStep(round.id, next).catch((e) => console.error('[advance] AI step failed', e));
  }

  return { changed: true, phase: next, phaseEndsAt: rows[0].phase_ends_at };
}

/**
 * Autopilot: the admin page (or scripts/dev/autopilot.ts) calls this every ~1s. Each call does at most ONE thing:
 * one AI call, one phase change, or nothing. Overlapping calls are safe (lease + compare-and-set everywhere).
 */
export async function tick(): Promise<AdvanceResponse & { ai?: RunAiResponse }> {
  const game = await getActiveGame();
  if (game.status !== 'IN_PROGRESS' || !game.current_round_id) return { changed: false, phase: null };

  const round = await getRound(game.current_round_id);
  const deadlinePassed = Date.now() >= Date.parse(round.phase_ends_at);

  if (!isAiPhase(round.phase)) {
    return deadlinePassed ? advance(round.phase) : { changed: false, phase: round.phase };
  }

  // DEBATE: out of time → stop requesting turns and move to the judge (partial debate). All turns done → move on now.
  if (round.phase === 'DEBATE' && (deadlinePassed || round.ai_step_status === 'done')) return advance('DEBATE');
  // OPENINGS waits for its minimum on-screen time; JUDGING moves on as soon as the verdict is stored.
  if (round.ai_step_status === 'done') {
    return round.phase === 'JUDGING' || deadlinePassed ? advance(round.phase) : { changed: false, phase: round.phase };
  }

  // AI work remains. After repeated (or non-retryable) failures: openings/judge can't be skipped → cancel + refund.
  // (A failing DEBATE turn needs no special case: the DEBATE budget runs out and we judge what exists.)
  const givenUp = round.ai_step_status === 'failed' && (!round.ai_error_retryable || round.ai_failures >= MAX_AI_FAILURES);
  if (givenUp) {
    if (round.phase === 'DEBATE') return { changed: false, phase: round.phase };
    const refunded = await cancelRound(round.id);
    console.warn(`[tick] ${round.phase} failed ${round.ai_failures}x → round cancelled, ${refunded} refunded`);
    return { changed: true, phase: 'CANCELLED' };
  }

  const ai = await runAiStep(round.id, round.phase).catch((e): RunAiResponse => ({ status: 'failed', error: String(e) }));
  return { changed: false, phase: round.phase, ai };
}

/**
 * Make the NEXT AI call for this phase (exactly one model request, or none if nothing is left) and commit it.
 * Safe to call repeatedly and concurrently:
 *   - only the request holding the round's lease calls the model; the others return 'skipped'
 *   - the commit is a compare-and-swap on the state revision; a stale result is discarded
 *   - the engine itself answers repeats of finished steps from the state (reused: true, no model call)
 */
export async function runAiStep(roundId: string, phase: Phase): Promise<RunAiResponse> {
  if (!isAiPhase(phase)) throw new GameError('BAD_REQUEST', 400, `${phase} has no AI step`);

  const round = await getRound(roundId);
  if (round.phase !== phase) return { status: 'skipped' };       // round has moved on
  if (round.ai_step_status === 'done') return { status: 'done' };

  // DEBATE budget check BEFORE taking the lease: don't start a turn that can't finish in time.
  const msLeft = Date.parse(round.phase_ends_at) - Date.now();
  if (phase === 'DEBATE' && msLeft < MIN_TURN_MS) return { status: 'skipped' };

  // ---------- Claim the lease (only one request per round may call the model) ----------
  const owner = randomUUID();
  const { data: leased, error: leaseError } = await db.rpc('claim_ai_lease', {
    p_round: roundId, p_owner: owner, p_seconds: LEASE_SECONDS,
  });
  if (leaseError) throw leaseError;
  const row = (leased as { state: unknown; revision: number }[] | null)?.[0];
  if (!row) return { status: 'skipped' };                         // someone else is mid-call (or no state row)

  const release = () => db.rpc('release_ai_lease', { p_round: roundId, p_owner: owner });

  try {
    const loaded = parseRoundState(row.state);
    if (!loaded.ok) {
      // Corrupt / missing state is never silently recreated (INTEGRATION.md §5).
      await recordFailure(roundId, phase, loaded.error);
      return { status: 'failed', error: loaded.error.message };
    }
    const state = loaded.state;

    // Tell clients "Agents thinking…" while the model call runs.
    await db.from('rounds').update({ ai_step_status: 'running' }).eq('id', roundId).eq('phase', phase);
    await db.rpc('bump_version');

    const ai = getAi();
    let next: AiRoundState;
    let message: PublicArgument | null = null;
    let verdict: Record<string, unknown> | null = null;
    let phaseDone: boolean;
    let telemetry: { model?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number; attempts?: number } | undefined;

    if (phase === 'OPENINGS') {
      const side = nextOpeningSide(state);
      if (!side) return await finishWithoutCall(roundId, owner, phase, state);
      const step = await ai.generateOpening(state, side, { timeoutMs: AGENT_TIMEOUT_MS });
      if (!step.ok) return await failStep(roundId, phase, step.error);
      next = step.state;
      message = step.argument;
      telemetry = step.telemetry;
      phaseDone = nextOpeningSide(next) === null;
    } else if (phase === 'DEBATE') {
      if (turnsOf(state) >= state.maxTurns) return await finishWithoutCall(roundId, owner, phase, state);
      const step = await ai.nextTurn(state, {
        submissions: await loadSubmissions(roundId),     // cumulative: every clue of the round, both sides
        turn: state.transcript.length + 1,              // makes a repeat of the same turn safe
        timeoutMs: Math.min(AGENT_TIMEOUT_MS, Math.max(msLeft, MIN_TURN_MS)),
      });
      if (!step.ok) {
        if (step.error.code === 'round_complete') return await finishWithoutCall(roundId, owner, phase, state);
        return await failStep(roundId, phase, step.error);
      }
      next = step.state;
      message = step.argument;                          // NOT step.private / step.telemetry: server-only
      telemetry = step.telemetry;
      phaseDone = turnsOf(next) >= next.maxTurns;
    } else {
      // JUDGING. Judge isolation is enforced inside the engine: it sees only the public scenario,
      // the locked interpretations and the public transcript. No bets, balances, clues or player ids.
      const step = await ai.judge(state, { timeoutMs: JUDGE_TIMEOUT_MS });
      if (!step.ok) return await failStep(roundId, phase, step.error);
      next = step.state;
      verdict = {
        winner: step.verdict.winner,
        explanation: step.verdict.explanation,
        summary: step.verdict.summary ?? null,
        scores: step.verdict.scores,
        verdict: step.verdict,
        complete: step.complete,
        turnsCompleted: step.turnsCompleted,
      };
      telemetry = step.telemetry;
      phaseDone = true;
    }
    // Server log only (never sent to clients): one line per successful model call.
    console.log(`[ai] ${phase}${message ? ` ${message.stage}:${message.side}${message.debateTurn ? `#${message.debateTurn}` : ''}` : ' judge'} ` +
      `${telemetry?.latencyMs ?? '?'}ms model=${telemetry?.model ?? '?'} tokens=${telemetry?.inputTokens ?? '?'}/${telemetry?.outputTokens ?? '?'}` +
      `${telemetry?.attempts !== undefined ? ` attempts=${telemetry.attempts}` : ''}`);

    // ---------- Commit (state CAS + public line/verdict + round status, one transaction) ----------
    const committed = await commit(roundId, owner, phase, state.revision, next, message, verdict, phaseDone);
    if (!committed) return { status: 'skipped' };       // lost a race: result discarded, someone else's is stored
    return { status: phaseDone ? 'done' : 'progress', message: message?.text };
  } finally {
    // No-op if commit already cleared the lease; otherwise frees it on failure/early return.
    await release();
  }
}

/* ==========================================================================================
 * 4. AI step helpers
 * ======================================================================================== */

const turnsOf = (s: AiRoundState) => s.transcript.filter((e) => e.stage === 'turn').length;
const nextOpeningSide = (s: AiRoundState): Side | null => {
  const has = (side: Side) => s.transcript.some((e) => e.stage === 'opening' && e.side === side);
  return !has('A') ? 'A' : !has('B') ? 'B' : null;
};

async function commit(
  roundId: string, owner: string, phase: Phase, expectedRevision: number, next: AiRoundState,
  message: PublicArgument | null, verdict: Record<string, unknown> | null, phaseDone: boolean,
): Promise<boolean> {
  const { data, error } = await db.rpc('commit_ai_step', {
    p_round: roundId,
    p_owner: owner,
    p_phase: phase,
    p_expected_revision: expectedRevision,
    p_new_revision: next.revision,
    p_state: JSON.parse(serializeRound(next)),
    p_message: message && {
      key: message.key, side: message.side, stage: message.stage, sequence: message.sequence,
      debateTurn: message.debateTurn ?? null, text: message.text,
    },
    p_verdict: verdict,
    p_ai_status: phaseDone ? 'done' : 'idle',
  });
  if (error) throw error;
  return data === true;
}

/** Nothing left to generate in this phase (e.g. retried after success): mark it done without a model call. */
async function finishWithoutCall(roundId: string, owner: string, phase: Phase, state: AiRoundState): Promise<RunAiResponse> {
  const ok = await commit(roundId, owner, phase, state.revision, state, null, null, true);
  return { status: ok ? 'done' : 'skipped' };
}

async function failStep(roundId: string, phase: Phase, error: AiError): Promise<RunAiResponse> {
  console.warn(`[ai] ${phase} failed: ${error.code}${error.modelErrorKind ? `/${error.modelErrorKind}` : ''}: ${error.message}`);
  await recordFailure(roundId, phase, error);
  return { status: 'failed', error: error.message };
}

/** Record a failed call on the round so the host (and the autopilot's retry limit) can see it. State is unchanged. */
async function recordFailure(roundId: string, phase: Phase, error: AiError) {
  const round = await getRound(roundId);
  await db.from('rounds')
    .update({
      ai_step_status: 'failed',
      ai_error: `${error.code}: ${error.message}`.slice(0, 500),
      ai_error_retryable: error.retryable,
      ai_failures: round.ai_failures + 1,
    })
    .eq('id', roundId).eq('phase', phase);
  await db.rpc('bump_version');
}

/* ==========================================================================================
 * 5. Cancel / reset
 * ======================================================================================== */

/** Cancel the round and refund every stake exactly once (SQL guarantees "once"). */
export async function cancelRound(roundId: string): Promise<number> {
  const { data, error } = await db.rpc('cancel_round', { p_round: roundId });
  if (error) throw error;
  return data as number;                        // how many players were refunded
}

/** Rehearsal helper: fresh game, all players back to 100, all cases unused. */
export async function resetGame(): Promise<string> {
  const { data, error } = await db.rpc('reset_game');
  if (error) throw error;
  return data as string;                        // the new game id
}
