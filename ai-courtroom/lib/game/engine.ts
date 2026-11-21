// Server-only: this file calls the AI (API keys) and uses the secret DB key.
import 'server-only';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { ai } from '@/lib/ai';
import { getActiveGame } from '@/lib/game/state';
import { GameError } from '@/lib/game/errors';
import type {
  AdvanceResponse, AgentLine, AudienceClue, Case, Phase, Side, Stage,
} from '@/types/game';

/* ==========================================================================================
 * 1. CONFIGURATION: the shape of a round. Change timings here, nowhere else.
 * ======================================================================================== */

// Every phase as a RUNTIME list (types vanish at runtime; Zod in the routes needs real values).
// `as const` keeps each item as its exact literal ('REVEAL', not just string).
export const ALL_PHASES = [
  'REVEAL', 'BETTING', 'OPENINGS', 'INJECT_1', 'REBUTTALS',
  'INJECT_2', 'FINALS', 'JUDGING', 'RESULTS', 'CANCELLED',
] as const;

// Which phase follows which. `Partial<Record<Phase, Phase>>` means:
// "an object whose keys are Phases and values are Phases, but not every key is required".
// RESULTS and CANCELLED have no entry because after them we start a NEW round instead.
export const NEXT: Partial<Record<Phase, Phase>> = {
  REVEAL: 'BETTING',
  BETTING: 'OPENINGS',
  OPENINGS: 'INJECT_1',
  INJECT_1: 'REBUTTALS',
  REBUTTALS: 'INJECT_2',
  INJECT_2: 'FINALS',
  FINALS: 'JUDGING',
  JUDGING: 'RESULTS',
};

// Target length of each phase in seconds (from the spec's timing table).
// `Record<Phase, number>` (no Partial) = TS errors if you forget a phase. Handy safety net.
export const SECONDS: Record<Phase, number> = {
  REVEAL: 8, BETTING: 15, OPENINGS: 8, INJECT_1: 12, REBUTTALS: 17,
  INJECT_2: 12, FINALS: 20, JUDGING: 20, RESULTS: 8, CANCELLED: 8,
};

// Phases where the server must call the AI when the phase BEGINS.
export const AI_PHASES: readonly Phase[] = ['OPENINGS', 'REBUTTALS', 'FINALS', 'JUDGING'];
const isAiPhase = (p: Phase) => AI_PHASES.includes(p);

// AI call limits. Two attempts × 25s = 50s, which fits inside Vercel's maxDuration = 60.
const AI_TIMEOUT_MS = 25_000;  // underscores in numbers are just for readability
const AI_ATTEMPTS = 2;
// If a step says "running" for longer than this, assume the server died mid-call and allow retry.
const STALE_RUNNING_MS = 90_000;

/* ==========================================================================================
 * 2. DATABASE ROW TYPE + small loaders
 * ======================================================================================== */

type RoundRow = {
  id: string;
  case_id: string;
  phase: Phase;
  phase_ends_at: string;
  ai_step_status: 'idle' | 'running' | 'done' | 'failed';
  ai_step_started_at: string | null;
};

async function getRound(roundId: string): Promise<RoundRow> {
  const { data, error } = await db.from('rounds').select('*').eq('id', roundId).single();
  if (error || !data) throw new GameError('BAD_REQUEST', 404, 'Round not found');
  return data as RoundRow;
}

/** Load the case for a round and convert DB column names to the shared Case type. */
async function loadCase(caseId: string): Promise<Case> {
  const { data: c, error } = await db.from('cases').select('*').eq('id', caseId).single();
  if (error || !c) throw new Error(`Case ${caseId} missing`);
  return {
    id: c.id, scenario: c.scenario, imageUrl: c.image_url,
    hypothesisA: c.hypothesis_a, hypothesisB: c.hypothesis_b, evidence: c.evidence_json,
  };
}

/** Everything both agents have said so far, in order. This is the PUBLIC transcript. */
async function loadTranscript(roundId: string): Promise<AgentLine[]> {
  const { data, error } = await db
    .from('debate_messages')
    .select('speaker, stage, line_text')
    .eq('round_id', roundId)
    .order('ordinal');                          // ascending by default
  if (error) throw error;
  return (data ?? []).map((m) => ({ side: m.speaker as Side, stage: m.stage as Stage, text: m.line_text }));
}

/**
 * Lock the clue window and pick up to 3 clues per side (random, done in SQL).
 * Calling it twice returns the SAME selection (the SQL function is idempotent).
 * The return type uses AudienceClue, so Dev 1 receives exactly the contract shape.
 */
async function selectClues(roundId: string, window: 1 | 2) {
  const { data, error } = await db.rpc('select_clues', { p_round: roundId, p_window: window });
  if (error) throw error;

  // `[] as AudienceClue[]` tells TS "this empty array will hold AudienceClues".
  const clues = { A: [] as AudienceClue[], B: [] as AudienceClue[] };
  for (const row of data ?? []) {
    clues[row.side as Side].push({ id: row.id, side: row.side, text: row.text, window });
  }
  return clues; // NOTE: Agent A only ever gets clues.A, Agent B only clues.B. Dev 1 must keep that.
}

/* ==========================================================================================
 * 3. SAFE AI CALLS: timeout + retry + validate
 *    AI output is UNTRUSTED. It can be slow, crash, or return garbage. We never save
 *    anything that doesn't pass these Zod schemas.
 * ======================================================================================== */

const LineSchema = z.object({ text: z.string().trim().min(1).max(800) });
const PairSchema = z.object({ A: LineSchema, B: LineSchema });
const VerdictSchema = z.object({
  winner: z.enum(['A', 'B']),                  // exactly A or B. No draws, no "C".
  rationale: z.string().trim().min(1).max(1500),
  scores: z.object({ A: z.number(), B: z.number() }),
});

/**
 * Reject if `promise` takes longer than `ms`.
 *
 * `<T>` is a GENERIC: a placeholder type. If you pass a Promise<Verdict>, T becomes
 * Verdict and you get back a Promise<Verdict>. One function works for every result type.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Call the AI, enforce a timeout, VALIDATE the output, retry once on any failure.
 *  - fn:     a function that starts the AI call (a function, not a promise, so we can call it again)
 *  - schema: the Zod schema the result must match
 * `z.ZodType<T>` = "a Zod schema that produces a T"; TS infers T from the schema you pass.
 */
async function callAi<T>(label: string, fn: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt++) {
    try {
      const raw = await withTimeout(fn(), AI_TIMEOUT_MS, label);
      return schema.parse(raw);                 // .parse THROWS if invalid → goes to catch → retry
    } catch (e) {
      lastError = e;
      console.warn(`[ai] ${label} attempt ${attempt} failed:`, e);
    }
  }
  throw lastError;                              // all attempts failed
}

/* ==========================================================================================
 * 4. GAME ACTIONS (called by the admin routes)
 * ======================================================================================== */

/** Start round 1. Safe to double-click: the second call sees the game is no longer in LOBBY. */
export async function startGame(): Promise<AdvanceResponse> {
  const game = await getActiveGame();
  if (game.status !== 'LOBBY') return { changed: false, phase: null };
  return startNextRound(game.id, game.round_number);
}

/**
 * Create the next round, or end the game after max_rounds.
 * `expectedRoundNumber` makes it idempotent: the SQL only acts if the game is still on
 * that round number, so two simultaneous calls can't create two rounds.
 */
async function startNextRound(gameId: string, expectedRoundNumber: number): Promise<AdvanceResponse> {
  const { data, error } = await db.rpc('start_next_round', {
    p_game: gameId,
    p_expected_round_number: expectedRoundNumber,
    p_reveal_seconds: SECONDS.REVEAL,
  });
  if (error) throw error;                       // e.g. NO_CASES_LEFT → toErrorResponse maps it
  const newRound = data?.[0];                   // SQL returns 0 or 1 rows
  if (newRound) return { changed: true, phase: newRound.phase, phaseEndsAt: newRound.phase_ends_at };

  // No new round: either someone else already started it, or the game just ended.
  const after = await getActiveGame();
  return { changed: after.status === 'GAME_OVER', phase: null };
}

/**
 * Move the current round from `expected` to the next phase.
 * The caller says which phase it THINKS we're in. If that's stale, nothing happens.
 * This is how "host clicks advance twice → phase changes once" is guaranteed.
 */
export async function advance(expected: Phase): Promise<AdvanceResponse> {
  const game = await getActiveGame();
  if (game.status === 'GAME_OVER') return { changed: false, phase: null };
  if (!game.current_round_id) throw new GameError('BAD_REQUEST', 409, 'Game not started — call /api/admin/start');

  const round = await getRound(game.current_round_id);

  // Stale request (double-click, two admin tabs, autopilot overlap) → harmless no-op.
  if (round.phase !== expected) return { changed: false, phase: round.phase };

  // End of a round → start the next one (or finish the game).
  if (expected === 'RESULTS' || expected === 'CANCELLED') {
    return startNextRound(game.id, game.round_number);
  }

  // Never leave an AI phase until its output is saved. (Host can retry via /run-ai, or /cancel.)
  if (isAiPhase(expected) && round.ai_step_status !== 'done') {
    throw new GameError('AI_NOT_DONE', 409, `AI step is "${round.ai_step_status}"`);
  }

  // `!` after NEXT[expected] = "I promise this isn't undefined". True here because
  // RESULTS/CANCELLED (the only phases without a NEXT entry) were handled above.
  const next = NEXT[expected]!;

  // Pay winners BEFORE the phase flips to RESULTS, so the moment players see RESULTS,
  // balances are already correct. settle_round is idempotent (a second call pays nothing).
  if (next === 'RESULTS') {
    const { error } = await db.rpc('settle_round', { p_round: round.id });
    if (error) throw error;
  }

  // The atomic compare-and-set in SQL: only updates if phase is STILL `expected`.
  const { data: rows, error } = await db.rpc('transition_phase', {
    p_round: round.id, p_expected: expected, p_next: next, p_seconds: SECONDS[next],
  });
  if (error) throw error;
  if (!rows?.length) return { changed: false, phase: expected }; // lost a race; someone else advanced

  // Entering an AI phase → run the AI now. We AWAIT it because on Vercel, work started
  // after the response is sent may be frozen. The phase change is already committed, so
  // players see "Agents thinking…" (aiStepStatus = 'running') while this runs.
  // If the AI fails, we don't fail the advance: runAiStep records 'failed' on the round
  // and the host decides: Retry (/run-ai) or Cancel (/cancel).
  if (isAiPhase(next)) {
    await runAiStep(round.id, next).catch((e) => console.error('[advance] AI step failed', e));
  }

  return { changed: true, phase: next, phaseEndsAt: rows[0].phase_ends_at };
}

/**
 * Autopilot: advance only if the current phase's deadline has passed and its AI work is done.
 * The admin page calls this every ~1s. Because advance() is idempotent, overlapping calls are fine.
 */
export async function tick(): Promise<AdvanceResponse> {
  const game = await getActiveGame();
  if (game.status !== 'IN_PROGRESS' || !game.current_round_id) return { changed: false, phase: null };

  const round = await getRound(game.current_round_id);
  const deadlinePassed = Date.now() >= Date.parse(round.phase_ends_at);
  if (!deadlinePassed) return { changed: false, phase: round.phase };

  // AI still working (or failed) → wait. On 'failed' the autopilot pauses for the host.
  if (isAiPhase(round.phase) && round.ai_step_status !== 'done') return { changed: false, phase: round.phase };

  return advance(round.phase);
}

/**
 * Run the AI work for an AI phase and save the result. Safe to call repeatedly:
 *  - "claims" the step first, so two simultaneous calls can't both run the AI
 *  - DB unique constraints stop duplicate messages/verdicts even if something slips through
 */
export async function runAiStep(roundId: string, phase: Phase): Promise<{ status: 'done' | 'skipped' }> {
  if (!isAiPhase(phase)) throw new GameError('BAD_REQUEST', 400, `${phase} has no AI step`);

  const round = await getRound(roundId);
  if (round.phase !== phase) return { status: 'skipped' };  // round has moved on

  // ---------- Can we claim this step? ----------
  const startedAt = round.ai_step_started_at ? Date.parse(round.ai_step_started_at) : 0;
  const isStale = round.ai_step_status === 'running' && Date.now() - startedAt > STALE_RUNNING_MS;
  const claimable = round.ai_step_status === 'idle' || round.ai_step_status === 'failed' || isStale;
  if (!claimable) return { status: 'skipped' };             // already done, or running right now

  // ---------- Claim it (compare-and-set) ----------
  // Only succeeds if the row STILL has the status/timestamp we just read. If another request
  // claimed it in between, zero rows match and we back off.
  let claim = db
    .from('rounds')
    .update({ ai_step_status: 'running', ai_step_started_at: new Date().toISOString(), ai_error: null })
    .eq('id', roundId)
    .eq('phase', phase)
    .eq('ai_step_status', round.ai_step_status);
  // SQL can't compare NULL with "=", so Supabase needs .is(..., null) for that case.
  claim = round.ai_step_started_at === null
    ? claim.is('ai_step_started_at', null)
    : claim.eq('ai_step_started_at', round.ai_step_started_at);
  const { data: claimed, error: claimError } = await claim.select('id');
  if (claimError) throw claimError;
  if (!claimed?.length) return { status: 'skipped' };

  await db.rpc('bump_version');                 // clients now see aiStepStatus = 'running'

  // ---------- Do the work ----------
  try {
    const caseData = await loadCase(round.case_id);
    const transcript = await loadTranscript(roundId);

    if (phase === 'JUDGING') {
      // JUDGE ISOLATION: the judge gets ONLY the case + public transcript.
      // No bets, balances, player names, or raw clues are passed. Keep it that way.
      const verdict = await callAi('judge', () => ai.judge({ caseData, transcript }), VerdictSchema);

      // upsert = insert, or overwrite if this round already has a verdict (e.g. retry).
      // The verdicts table is unreadable by browsers; /api/state only reveals it after settlement.
      const { error } = await db.from('verdicts').upsert({
        round_id: roundId, winner: verdict.winner,
        rationale: verdict.rationale, scores_json: verdict.scores,
      });
      if (error) throw error;
    } else {
      // Map phase → stage name used in the transcript.
      const stage: Stage = phase === 'OPENINGS' ? 'opening' : phase === 'REBUTTALS' ? 'rebuttal' : 'final';

      // Openings have no clues; rebuttals use window 1; finals use window 2.
      const pair = phase === 'OPENINGS'
        ? await callAi('opening', () => ai.generateOpening({ caseData }), PairSchema)
        : await callAi(stage, async () => ai.generatePair({
            caseData,
            transcript,
            stage: stage as 'rebuttal' | 'final',
            selectedClues: await selectClues(roundId, phase === 'REBUTTALS' ? 1 : 2),
          }), PairSchema);

      // Save both lines. Ordinals continue the transcript: openings 1–2, rebuttals 3–4, finals 5–6.
      // We set side/stage OURSELVES (not trusting the model's fields).
      // ignoreDuplicates + the unique (round_id, stage, speaker) constraint = retry-safe.
      const sides = ['A', 'B'] as const;
      const { error } = await db.from('debate_messages').upsert(
        sides.map((side, i) => ({
          round_id: roundId, stage, speaker: side,
          line_text: pair[side].text, ordinal: transcript.length + i + 1,
        })),
        { onConflict: 'round_id,stage,speaker', ignoreDuplicates: true },
      );
      if (error) throw error;
    }

    // ---------- Success ----------
    await db.from('rounds').update({ ai_step_status: 'done' }).eq('id', roundId).eq('phase', phase);
    await db.rpc('bump_version');
    return { status: 'done' };
  } catch (e) {
    // ---------- Failure: record it so the host can see what went wrong ----------
    await db.from('rounds')
      .update({ ai_step_status: 'failed', ai_error: String(e).slice(0, 500) })
      .eq('id', roundId);
    await db.rpc('bump_version');
    throw e;                                    // let the caller decide what to do
  }
}

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