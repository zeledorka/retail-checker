// 'server-only' makes the BUILD FAIL if a browser component ever imports this file. This protects the secret key used by `db`.
// The join, state, and leaderboard APIs overlap in data needs, so this file covers loading them.
import 'server-only';
import { db } from '@/lib/supabase/admin';
import { MAX_TURNS } from '@/lib/game/constants';
import type {
  Case, LeaderboardEntry, Phase, PublicMessage, PublicRound, PublicVerdict, Side, StateResponse,
} from '@/types/game';

type GameRow = {
  id: string; status: 'LOBBY' | 'IN_PROGRESS' | 'GAME_OVER';
  current_round_id: string | null; round_number: number; max_rounds: number; version: number; autopilot: boolean;
};
type RoundRow = {
  id: string; case_id: string; round_number: number; phase: Phase;
  phase_started_at: string; phase_ends_at: string;
  ai_step_status: 'idle' | 'running' | 'done' | 'failed';
  winner: Side | null; settled_at: string | null;
};
type CaseRow = {
  id: string; title: string; description: string; interpretation_a: string; interpretation_b: string;
  evidence_json: string[]; image_url: string | null;
};
type MessageRow = {
  id: string; arg_key: string; speaker: Side; stage: 'opening' | 'turn'; ordinal: number;
  debate_turn: number | null; line_text: string; created_at: string;
};
type VerdictRow = {
  winner: Side; rationale: string; summary: string | null; scores_json: PublicVerdict['scores'];
  complete: boolean; turns_completed: number;
};

/* ------------------------------------------------------------------------------------------
 * Row types: what the DATABASE returns (snake_case column names).
 * The API types in types/game.ts use camelCase. The "toXxx" functions below convert
 * between them. This separation means a DB rename never silently changes the API.
 * ---------------------------------------------------------------------------------------- */
const toCase = (c: CaseRow): Case => ({
  id: c.id,
  title: c.title,
  description: c.description,
  evidence: c.evidence_json,
  interpretationA: c.interpretation_a,
  interpretationB: c.interpretation_b,
  imageUrl: c.image_url,
});

const toMessage = (m: MessageRow): PublicMessage => ({
  id: m.id, key: m.arg_key, side: m.speaker, stage: m.stage, sequence: m.ordinal,
  debateTurn: m.debate_turn, text: m.line_text, createdAt: m.created_at,
});

const toVerdict = (v: VerdictRow): PublicVerdict => ({
  winner: v.winner, explanation: v.rationale, summary: v.summary, scores: v.scores_json,
  complete: v.complete, turnsCompleted: v.turns_completed,
});

/** Fetch the single active game. Throws if missing (means the migration wasn't run). */
export async function getActiveGame(): Promise<GameRow> {
  // Supabase query builder reads like SQL:
  //   select * from games where is_active = true   (and expect exactly one row)
  const { data, error } = await db.from('games').select('*').eq('is_active', true).single();
  // `throw` stops this function; the calling route's try/catch turns it into a 500.
  if (error || !data) throw new Error(`No active game: ${error?.message}`);
  return data as GameRow; // "as GameRow" tells TS what shape to expect (Supabase can't know)
}

/** The public subset of the game. Note: no internal fields like is_active. */
export const toPublicGame = (g: GameRow) => ({
  id: g.id, status: g.status, roundNumber: g.round_number, maxRounds: g.max_rounds, autopilot: g.autopilot ?? false,
});

/** Leaderboard sorted by tokens, then correct picks (the announced tie-break). */
export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  const { data, error } = await db.from('leaderboard').select('nickname, tokens, correct_picks');
  if (error) throw error;

  // `?? []` = if data is null, use an empty array so .map doesn't crash.
  return (data ?? [])
    .map((row) => ({
      nickname: row.nickname as string,
      tokens: row.tokens as number,
      correctPicks: Number(row.correct_picks), // Postgres count() comes back as a string/bigint
    }))
    // sort((a, b) => ...) : negative = a first, positive = b first.
    .sort((a, b) => b.tokens - a.tokens || b.correctPicks - a.correctPicks);
}

/**
 * Build the full StateResponse for /api/state.
 * @param userId  the signed-in player's id, or null for the projector /display screen.
 *
 * SECURITY RULES ENFORCED HERE (this is "the serializer" the spec talks about):
 *   - verdict winner/explanation only after the round is settled AND in RESULTS (DB column `rationale` → API `explanation`)
 *   - audience clues are never public (only the player's own clue, in `me`); the AI state is never read here
 *   - other players' bets are never included
 */
export async function buildState(userId: string | null): Promise<StateResponse> {
  const game = await getActiveGame();

  // Load the current round if there is one. `let` (not const) because we assign it later.
  let round: RoundRow | null = null;
  if (game.current_round_id) {
    const { data } = await db.from('rounds').select('*').eq('id', game.current_round_id).single();
    round = data as RoundRow | null;
  }

  // ---- Round-specific data: run the independent queries IN PARALLEL with Promise.all. ----
  // Promise.all takes an array of promises and waits for all of them; much faster than
  // awaiting one after another. The `[a, b, c] = await ...` syntax unpacks the results.
  let caseData: Case | null = null;
  let messages: PublicMessage[] = [];
  let verdict: PublicVerdict | null = null;

  // A round's result is revealed only when BOTH are true.
  const revealed = round !== null && round.phase === 'RESULTS' && round.settled_at !== null;

  if (round) {
    // Public lines come from debate_messages (written in the same transaction as the AI state).
    // We never read ai_round_states here: it holds private audience messages and player ids.
    const [caseRes, msgRes, verdictRes] = await Promise.all([
      db.from('cases').select('*').eq('id', round.case_id).single(),
      db.from('debate_messages').select('*').eq('round_id', round.id).order('ordinal'),
      // Only even ASK the DB for the verdict when it's revealed.
      revealed
        ? db.from('verdicts').select('winner, rationale, summary, scores_json, complete, turns_completed')
            .eq('round_id', round.id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    if (caseRes.data) caseData = toCase(caseRes.data as CaseRow);
    messages = ((msgRes.data ?? []) as MessageRow[]).map(toMessage);
    if (verdictRes.data) verdict = toVerdict(verdictRes.data as VerdictRow);
  }

  const publicRound: PublicRound | null = round && {
    id: round.id,
    roundNumber: round.round_number,
    phase: round.phase,
    phaseStartedAt: round.phase_started_at,
    phaseEndsAt: round.phase_ends_at,
    aiStepStatus: round.ai_step_status,
    turnsCompleted: messages.filter((m) => m.stage === 'turn').length,
    maxTurns: MAX_TURNS,
    winner: revealed ? round.winner : null,  // <- the critical gate
    verdict: revealed ? verdict : null,
  };

  // ---- "me": only when a player is signed in ----
  let me: StateResponse['me'] = null; // `StateResponse['me']` = "the type of the me field"
  if (userId) {
    const [playerRes, betRes, injRes] = await Promise.all([
      db.from('players').select('nickname, tokens').eq('id', userId).maybeSingle(),
      round
        ? db.from('bets').select('side, stake').eq('round_id', round.id).eq('player_id', userId).maybeSingle()
        : Promise.resolve({ data: null }),
      round
        ? db.from('injections').select('text').eq('round_id', round.id).eq('player_id', userId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    // A signed-in user who hasn't called /api/join yet has no player row, so me stays null.
    if (playerRes.data) {
      me = {
        nickname: playerRes.data.nickname,
        tokens: playerRes.data.tokens,
        bet: (betRes.data as { side: Side; stake: number } | null) ?? null,
        injection: (injRes.data as { text: string } | null) ?? null,
      };
    }
  }

  return {
    version: game.version,
    serverNow: new Date().toISOString(), // client computes: offset = serverNow - Date.now()
    game: toPublicGame(game),
    round: publicRound,
    case: caseData,
    publicMessages: messages,
    me,
    leaderboard: await getLeaderboard(),
  };
}