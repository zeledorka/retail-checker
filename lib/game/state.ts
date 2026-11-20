// 'server-only' makes the BUILD FAIL if a browser component ever imports this file. This protects the secret key used by `db`.
// The join, state, and leaderboard APIs overlap in data needs, so this file covers loading them.
import 'server-only';
import { db } from '@/lib/supabase/admin';
import type {
  AudienceClue, Case, LeaderboardEntry, Phase, PublicMessage, PublicRound, Side, StateResponse,
} from '@/types/game';

type GameRow = {
  id: string; status: 'LOBBY' | 'IN_PROGRESS' | 'GAME_OVER';
  current_round_id: string | null; round_number: number; max_rounds: number; version: number;
};
type RoundRow = {
  id: string; case_id: string; round_number: number; phase: Phase;
  phase_started_at: string; phase_ends_at: string;
  ai_step_status: 'idle' | 'running' | 'done' | 'failed';
  winner: Side | null; settled_at: string | null;
};
type CaseRow = {
  id: string; scenario: string; hypothesis_a: string; hypothesis_b: string;
  evidence_json: string[]; image_url: string;
};

/* ------------------------------------------------------------------------------------------
 * Row types: what the DATABASE returns (snake_case column names).
 * The API types in types/game.ts use camelCase. The "toXxx" functions below convert
 * between them. This separation means a DB rename never silently changes the API.
 * ---------------------------------------------------------------------------------------- */
const toCase = (c: CaseRow): Case => ({
  id: c.id,
  scenario: c.scenario,
  hypothesisA: c.hypothesis_a,
  hypothesisB: c.hypothesis_b,
  evidence: c.evidence_json,
  imageUrl: c.image_url,
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
  id: g.id, status: g.status, roundNumber: g.round_number, maxRounds: g.max_rounds,
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
 *   - verdict winner/rationale only after the round is settled AND in RESULTS
 *   - only SELECTED clues are public, and never with player ids
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
  const selectedClues: { A: AudienceClue[]; B: AudienceClue[] } = { A: [], B: [] };
  let rationale: string | null = null;

  // A round's result is revealed only when BOTH are true.
  const revealed = round !== null && round.phase === 'RESULTS' && round.settled_at !== null;

  if (round) {
    const [caseRes, msgRes, clueRes, verdictRes] = await Promise.all([
      db.from('cases').select('*').eq('id', round.case_id).single(),
      db.from('debate_messages').select('*').eq('round_id', round.id).order('ordinal'),
      // Select specific columns ONLY. We deliberately do not select player_id.
      db.from('injections').select('id, side, text, inject_window')
        .eq('round_id', round.id).eq('selected', true),
      // Only even ASK the DB for the verdict when it's revealed. Promise.resolve(...) is a
      // ready-made "fake" result so the array shape stays the same.
      revealed
        ? db.from('verdicts').select('rationale').eq('round_id', round.id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    if (caseRes.data) caseData = toCase(caseRes.data as CaseRow);

    messages = (msgRes.data ?? []).map((m) => ({
      id: m.id, side: m.speaker, text: m.line_text, stage: m.stage,
      ordinal: m.ordinal, createdAt: m.created_at,
    }));

    for (const c of clueRes.data ?? []) {
      // `as Side` narrows a plain string to 'A' | 'B' so we can use it as an object key.
      selectedClues[c.side as Side].push({
        id: c.id, side: c.side, text: c.text, window: c.inject_window as 1 | 2,
      });
    }

    rationale = (verdictRes.data as { rationale: string } | null)?.rationale ?? null;
  }

  const publicRound: PublicRound | null = round && {
    id: round.id,
    roundNumber: round.round_number,
    phase: round.phase,
    phaseStartedAt: round.phase_started_at,
    phaseEndsAt: round.phase_ends_at,
    aiStepStatus: round.ai_step_status,
    selectedClues,
    winner: revealed ? round.winner : null,  // <- the critical gate
    rationale: revealed ? rationale : null,
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
        ? db.from('injections').select('inject_window, text').eq('round_id', round.id).eq('player_id', userId)
        : Promise.resolve({ data: [] }),
    ]);
    // A signed-in user who hasn't called /api/join yet has no player row, so me stays null.
    if (playerRes.data) {
      me = {
        nickname: playerRes.data.nickname,
        tokens: playerRes.data.tokens,
        bet: (betRes.data as { side: Side; stake: number } | null) ?? null,
        injections: ((injRes.data ?? []) as { inject_window: 1 | 2; text: string }[])
          .map((i) => ({ window: i.inject_window, text: i.text })),
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