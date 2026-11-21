// lib/game/engine.ts
import 'server-only';
import { db } from '@/lib/supabase/admin';
import { ai } from '@/lib/ai';
import type { Phase, AgentLine, AudienceClue, Case } from '@/types/game';

export const NEXT: Partial<Record<Phase, Phase>> = {
  REVEAL: 'BETTING', BETTING: 'OPENINGS', OPENINGS: 'INJECT_1', INJECT_1: 'REBUTTALS',
  REBUTTALS: 'INJECT_2', INJECT_2: 'FINALS', FINALS: 'JUDGING', JUDGING: 'RESULTS',
};
export const SECONDS: Record<Phase, number> = {
  REVEAL: 8, BETTING: 15, OPENINGS: 8, INJECT_1: 12, REBUTTALS: 17,
  INJECT_2: 12, FINALS: 20, JUDGING: 20, RESULTS: 8, CANCELLED: 8,
};
export const AI_PHASES: Phase[] = ['OPENINGS', 'REBUTTALS', 'FINALS', 'JUDGING'];

// Get current round and advance
export async function advance(expected: Phase) {
  const { data: game } = await db.from('games').select('*').eq('is_active', true).single();
  const { data: round } = game.current_round_id
    ? await db.from('rounds').select('*').eq('id', game.current_round_id).single() : { data: null };

  // End of round (or lobby): start next round / game over
  if (!round || expected === 'RESULTS' || expected === 'CANCELLED') {
    if (round && round.phase !== expected) return { changed: false, phase: round.phase };
    const { data, error } = await db.rpc('start_next_round', {
        // By this point, it is not next round yet, so show the current round and remaining timer
      p_game: game.id, p_expected_round_number: game.round_number, p_reveal_seconds: SECONDS.REVEAL });
    if (error) throw error;
    return { changed: !!data?.length, phase: data?.[0]?.phase ?? null };
  }
  if (round.phase !== expected) return { changed: false, phase: round.phase };
  if (AI_PHASES.includes(expected) && round.ai_step_status !== 'done') throw new Error('AI_NOT_DONE');

  const next = NEXT[expected]!;
  if (next === 'RESULTS') { const { error } = await db.rpc('settle_round', { p_round: round.id }); if (error) throw error; }
  const { data: rows, error } = await db.rpc('transition_phase', {
    p_round: round.id, p_expected: expected, p_next: next, p_seconds: SECONDS[next] });
  if (error) throw error;
  if (!rows?.length) return { changed: false, phase: expected };
  if (AI_PHASES.includes(next)) await runAiStep(round.id, next).catch(() => {}); // failure is recorded on the round
  return { changed: true, phase: next, phaseEndsAt: rows[0].phase_ends_at };
}

// Running AI state
export async function runAiStep(roundId: string, phase: Phase) {
  // Claim the step: only one request may run it. Also reclaim if stuck "running" > 90s (function killed).
  const stale = new Date(Date.now() - 90_000).toISOString();
  const { data: claimed } = await db.from('rounds')
    .update({ ai_step_status: 'running', ai_step_started_at: new Date().toISOString(), ai_error: null })
    .eq('id', roundId).eq('phase', phase)
    .or(`ai_step_status.in.(idle,failed),and(ai_step_status.eq.running,ai_step_started_at.lt.${stale})`)
    .select('id');
  if (!claimed?.length) return { status: 'skipped' as const };

  try {
    const caseData = await loadCase(roundId);
    const transcript = await loadTranscript(roundId);
    if (phase === 'JUDGING') {
      const verdict = await retry(() => timeout(ai.judge({ caseData, transcript }), 25_000), 2);
      // TODO: validate with zod: winner A|B, rationale non-empty
      await db.from('verdicts').upsert({ round_id: roundId, winner: verdict.winner,
        rationale: verdict.rationale, scores_json: verdict.scores });
    } else {
      const pair = phase === 'OPENINGS'
        ? await ai.generateOpening({ caseData })
        : await ai.generatePair({ caseData, transcript, stage: phase === 'REBUTTALS' ? 'rebuttal' : 'final',
            selectedClues: await selectClues(roundId, phase === 'REBUTTALS' ? 1 : 2) });
      await db.from('debate_messages').upsert(
        (['A', 'B'] as const).map((s, i) => ({ round_id: roundId, stage: pair[s].stage, speaker: s,
          line_text: pair[s].text, ordinal: transcript.length + i + 1 })),
        { onConflict: 'round_id,stage,speaker', ignoreDuplicates: true });
    }
    await db.from('rounds').update({ ai_step_status: 'done' }).eq('id', roundId).eq('phase', phase);
    return { status: 'done' as const };
  } catch (e) {
    await db.from('rounds').update({ ai_step_status: 'failed', ai_error: String(e).slice(0, 500) }).eq('id', roundId);
    throw e;
  }
}
// helpers you write: loadCase (map snake_case → Case), loadTranscript (order by ordinal → AgentLine[]),
// selectClues (rpc 'select_clues' → {A: AudienceClue[], B: AudienceClue[]}), retry, timeout