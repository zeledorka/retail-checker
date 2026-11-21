/**
 * End-to-end simulation against a running dev server + the real Supabase DB (mock AI).
 *
 *   npx tsx --env-file=.env scripts/dev/simulate.ts               full 5-round game until GAME_OVER (server: AI_MODE=mock)
 *   npx tsx --env-file=.env scripts/dev/simulate.ts --judge-fail  server started with MOCK_JUDGE_FAIL=1:
 *                                                                 round 1 must be CANCELLED with one refund per bettor
 *   BASE_URL=http://localhost:3001 ...                            other server
 *
 * RESETS THE ACTIVE GAME. Creates 5 anonymous Supabase users per run. Full game takes ~5-6 minutes.
 * Prints PASS/FAIL per check, exits 1 on any FAIL.
 */
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN = process.env.ADMIN_SECRET;
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const JUDGE_FAIL = process.argv.includes('--judge-fail');
const WAIT_TIMEOUT_MS = 180_000;
const CLUE = 'The lock has no scratches, so a key was used.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
let failures = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  if (!ok) failures++;
  const d = detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`);
}

type Res = { status: number; body: any };
async function call(method: string, path: string, opts: { token?: string; admin?: boolean | string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.admin) headers['x-admin-secret'] = opts.admin === true ? ADMIN! : opts.admin;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const tick = () => call('POST', '/api/admin/tick', { admin: true });
const state = (token?: string) => call('GET', '/api/state', { token }).then((r) => r.body);
const errCode = (r: Res) => r.body?.error?.code;

type Player = { name: string; token: string; id: string };
async function newPlayer(name: string): Promise<Player> {
  const sb = createClient(URL_!, PUB!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error || !data.session) throw new Error(`anonymous sign-in failed for ${name}: ${error?.message}`);
  const p = { name, token: data.session.access_token, id: data.user!.id };
  const j = await call('POST', '/api/join', { token: p.token, body: { nickname: name } });
  if (j.status !== 200) throw new Error(`join ${name} failed: ${j.status} ${JSON.stringify(j.body)}`);
  return p;
}

/** Tick once a second until `done(state)` is true. Returns that state. */
async function tickUntil(done: (s: any) => boolean, label: string): Promise<any> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const t = await tick();
    if (t.status !== 200) console.log(ts(), `   tick HTTP ${t.status}`, JSON.stringify(t.body));
    if (t.body?.ai?.status === 'failed') console.log(ts(), '   AI failed:', t.body.ai.error);
    const s = await state();
    const where = `${s?.game?.status} r${s?.round?.roundNumber ?? '-'} ${s?.round?.phase ?? '(none)'}`;
    if (where !== last) { console.log(ts(), `── ${where}`); last = where; }
    if (done(s)) return s;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label} (last: ${last})`);
}
const at = (round: number, phases: string[]) => (s: any) => s?.round?.roundNumber === round && phases.includes(s?.round?.phase);

async function main() {
  for (const [k, v] of Object.entries({ ADMIN_SECRET: ADMIN, NEXT_PUBLIC_SUPABASE_URL: URL_, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SECRET_KEY: SECRET })) {
    if (!v) throw new Error(`${k} missing: run with --env-file=.env`);
  }
  const db = createClient(URL_!, SECRET!, { auth: { persistSession: false } });   // read-only checks of ledger/verdicts
  console.log(`simulate: ${BASE} mode=${JUDGE_FAIL ? 'judge-fail' : 'full game'}`);

  // ---------- admin auth: every admin route rejects a missing / wrong secret (before anything changes) ----------
  const adminRoutes: [string, unknown][] = [
    ['/api/admin/reset', undefined], ['/api/admin/start', undefined], ['/api/admin/tick', undefined],
    ['/api/admin/advance', { expectedPhase: 'REVEAL' }],
    ['/api/admin/run-ai', { roundId: '00000000-0000-0000-0000-000000000000', expectedPhase: 'OPENINGS' }],
    ['/api/admin/cancel', { roundId: '00000000-0000-0000-0000-000000000000' }],
  ];
  for (const [path, body] of adminRoutes) {
    const none = await call('POST', path, { body });
    const wrong = await call('POST', path, { body, admin: 'wrong-secret' });
    check(`${path} without / with wrong x-admin-secret → 403`, none.status === 403 && wrong.status === 403 && errCode(none) === 'FORBIDDEN', [none.status, wrong.status]);
  }

  // ---------- setup ----------
  const reset = await call('POST', '/api/admin/reset', { admin: true });
  check('reset game', reset.status === 200, reset.status === 200 ? '' : reset.body);
  if (reset.status !== 200) throw new Error('cannot continue without a reset');
  const gameId: string = reset.body.gameId;
  const alice = await newPlayer('SimAlice'), bob = await newPlayer('SimBob'), carol = await newPlayer('SimCarol');
  const dave = await newPlayer('SimDave'), erin = await newPlayer('SimErin');
  const players = [alice, bob, carol, dave, erin];
  const expected: Record<string, number> = Object.fromEntries(players.map((p) => [p.id, 100]));
  const me0 = (await state(alice.token))?.me;
  check('join: new player has 100 tokens', me0?.tokens === 100, me0);

  /** tokens == sum(token_ledger.delta) for every sim player, and == our own running expectation. */
  async function ledgerInvariant(label: string) {
    const ids = players.map((p) => p.id);
    const [{ data: rows }, { data: ledger }] = await Promise.all([
      db.from('players').select('id, tokens').in('id', ids),
      db.from('token_ledger').select('player_id, delta').in('player_id', ids),
    ]);
    const sums: Record<string, number> = {};
    for (const l of ledger ?? []) sums[l.player_id] = (sums[l.player_id] ?? 0) + l.delta;
    const bad = (rows ?? []).filter((r) => r.tokens !== sums[r.id] || r.tokens !== expected[r.id]);
    const name = (id: string) => players.find((p) => p.id === id)!.name;
    check(`${label}: tokens = Σ ledger deltas = expected, for all ${ids.length} players`, (rows ?? []).length === ids.length && bad.length === 0,
      bad.length ? bad.map((r) => ({ p: name(r.id), tokens: r.tokens, ledger: sums[r.id], expected: expected[r.id] }))
        : Object.fromEntries((rows ?? []).map((r) => [name(r.id), r.tokens])));
  }

  const start = await call('POST', '/api/admin/start', { admin: true });
  check('start round 1 → REVEAL', start.status === 200 && start.body?.phase === 'REVEAL', start.body);

  // ================= ROUND 1: the detailed round =================
  await tickUntil(at(1, ['BETTING']), 'BETTING r1');
  const roundId: string = (await state()).round.id;
  const bets: { p: Player; side: 'A' | 'B'; stake: number }[] = [];
  const b1 = await call('POST', '/api/bet', { token: alice.token, body: { roundId, side: 'A', stake: 20 } });
  check('alice bets 20 on A', b1.status === 200 && b1.body?.tokensRemaining === 80, b1.body);
  const b2 = await call('POST', '/api/bet', { token: bob.token, body: { roundId, side: 'B', stake: 30 } });
  check('bob bets 30 on B', b2.status === 200 && b2.body?.tokensRemaining === 70, b2.body);
  bets.push({ p: alice, side: 'A', stake: 20 }, { p: bob, side: 'B', stake: 30 });
  const b3 = await call('POST', '/api/bet', { token: alice.token, body: { roundId, side: 'B', stake: 5 } });
  check('second bet from same player → ALREADY_BET', b3.status === 409 && errCode(b3) === 'ALREADY_BET', b3.body);
  const over = await call('POST', '/api/bet', { token: carol.token, body: { roundId, side: 'A', stake: 101 } });
  check('stake above balance (101 of 100) → INSUFFICIENT_TOKENS', over.status === 409 && errCode(over) === 'INSUFFICIENT_TOKENS', over.body);

  // Two simultaneous all-in bets from Dave: exactly one accepted, tokens deducted once.
  const race = await Promise.all([
    call('POST', '/api/bet', { token: dave.token, body: { roundId, side: 'A', stake: 100 } }),
    call('POST', '/api/bet', { token: dave.token, body: { roundId, side: 'B', stake: 100 } }),
  ]);
  const accepted = race.filter((r) => r.status === 200);
  const rejected = race.filter((r) => r.status === 409 && ['ALREADY_BET', 'INSUFFICIENT_TOKENS'].includes(errCode(r)));
  const daveMe = (await state(dave.token))?.me;
  check('2 simultaneous bets from one player → exactly one accepted', accepted.length === 1 && rejected.length === 1 && daveMe?.tokens === 0 && daveMe?.bet?.stake === 100,
    { responses: race.map((r) => r.body), tokens: daveMe?.tokens, bet: daveMe?.bet });
  const daveSide: 'A' | 'B' = daveMe?.bet?.side ?? 'A';
  const erinSide: 'A' | 'B' = daveSide === 'A' ? 'B' : 'A';
  const be = await call('POST', '/api/bet', { token: erin.token, body: { roundId, side: erinSide, stake: 100 } });
  check(`erin bets all-in on ${erinSide} (one of dave/erin will hit 0)`, be.status === 200 && be.body?.tokensRemaining === 0, be.body);
  bets.push({ p: dave, side: daveSide, stake: 100 }, { p: erin, side: erinSide, stake: 100 });
  for (const b of bets) expected[b.p.id] -= b.stake;

  const early = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'too early' } });
  check('inject during BETTING → INJECTION_CLOSED', errCode(early) === 'INJECTION_CLOSED', early.body);

  // ---------- OPENINGS: clue window ----------
  await tickUntil(at(1, ['OPENINGS', 'DEBATE']), 'OPENINGS r1');
  const noBet = await call('POST', '/api/inject', { token: carol.token, body: { roundId, text: 'I never bet' } });
  check('inject with no bet → NO_BET', noBet.status === 409 && errCode(noBet) === 'NO_BET', noBet.body);
  const tooLong = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'x'.repeat(201) } });
  check('inject 201 chars → BAD_REQUEST', tooLong.status === 400 && errCode(tooLong) === 'BAD_REQUEST', tooLong.body);
  const clue = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: CLUE } });
  check('alice submits a clue', clue.status === 200 && clue.body?.accepted === true, clue.body);
  const clue2 = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'second clue' } });
  check('second clue same round → ALREADY_INJECTED', clue2.status === 409 && errCode(clue2) === 'ALREADY_INJECTED', clue2.body);

  // ---------- DEBATE: a fresh state fetch (page reload) restores me.bet / me.injection ----------
  const inDebate = await tickUntil(at(1, ['DEBATE', 'JUDGING', 'RESULTS', 'CANCELLED']), 'DEBATE r1');
  if (inDebate.round.phase === 'DEBATE') {
    const [a, b, c] = await Promise.all([state(alice.token), state(bob.token), state(carol.token)]);
    check('mid-DEBATE fresh GET /api/state restores me.bet + me.injection',
      a?.round?.phase === 'DEBATE' && a?.me?.bet?.side === 'A' && a?.me?.bet?.stake === 20 && a?.me?.injection?.text === CLUE &&
      b?.me?.bet?.side === 'B' && b?.me?.injection === null && c?.me?.bet === null && c?.me?.injection === null,
      { alice: a?.me, bob: b?.me, carol: c?.me });
  } else {
    check('mid-DEBATE fresh GET /api/state restores me.bet + me.injection', false, `DEBATE not observed (jumped to ${inDebate.round.phase})`);
  }

  // ---------- JUDGING ----------
  const judging = await tickUntil(at(1, ['JUDGING', 'RESULTS', 'CANCELLED']), 'JUDGING r1');
  check('round reached JUDGING (not skipped)', judging.round.phase === 'JUDGING', judging.round.phase);
  if (judging.round.phase === 'JUDGING') {
    const late = await call('POST', '/api/inject', { token: bob.token, body: { roundId, text: 'too late' } });
    check('inject after its window (JUDGING) → INJECTION_CLOSED', late.status === 409 && errCode(late) === 'INJECTION_CLOSED', late.body);
    const pub = await state();
    const priv = await state(bob.token);
    const leakFree = (s: any) => s?.round?.winner === null && s?.round?.verdict === null && !/"explanation"|"rationale"/.test(JSON.stringify(s));
    check('GET /api/state during JUDGING has no winner/verdict (projector + player)', leakFree(pub) && leakFree(priv), pub?.round);
    const msgs = (pub?.publicMessages ?? []) as any[];
    const count = (st: string) => msgs.filter((m) => m.stage === st).length;
    check('debate: 2 openings + 8 turns in publicMessages', count('opening') === 2 && count('turn') === 8, { openings: count('opening'), turns: count('turn') });
    check('no audience clue text leaks into public state', !JSON.stringify(pub).includes(CLUE));
  }

  if (JUDGE_FAIL) {
    // ---------- judge keeps failing → autopilot cancels + refunds ----------
    const end = await tickUntil(at(1, ['CANCELLED', 'RESULTS']), 'CANCELLED');
    check('judge failure → round CANCELLED', end.round.phase === 'CANCELLED', end.round.phase);
    for (const b of bets) expected[b.p.id] += b.stake;
    const again = await call('POST', '/api/admin/cancel', { admin: true, body: { roundId } });
    check('cancel again refunds nobody', again.status === 200 && again.body?.refunded === 0, again.body);
    await Promise.all([tick(), tick(), tick()]);
    const { data: refunds } = await db.from('token_ledger').select('player_id, delta').eq('round_id', roundId).eq('type', 'refund');
    check(`exactly one refund row per bettor (${bets.length}), each = stake`,
      refunds?.length === bets.length && bets.every((b) => refunds.some((r) => r.player_id === b.p.id && r.delta === b.stake)), refunds);
    const { data: ver } = await db.from('verdicts').select('round_id').eq('round_id', roundId);
    check('no verdict stored for the cancelled round', (ver ?? []).length === 0, ver);
    await ledgerInvariant('after cancel');
  } else {
    // ---------- duplicate ticks while JUDGING is done: settle must pay once ----------
    const dup = await Promise.all([tick(), tick(), tick(), tick()]);
    check('4 concurrent ticks during JUDGING all succeed', dup.every((d) => d.status === 200), dup.map((d) => d.status));
    const res1 = await tickUntil(at(1, ['RESULTS']), 'RESULTS r1');
    const winner: 'A' | 'B' = res1.round.winner;
    check('RESULTS reveals winner + verdict', (winner === 'A' || winner === 'B') && !!res1.round.verdict?.explanation, res1.round.verdict);
    for (const b of bets) if (b.side === winner) expected[b.p.id] += 2 * b.stake;
    await ledgerInvariant(`round 1 (winner ${winner})`);

    const stale = await call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'JUDGING' } });
    check('stale advance(JUDGING) in RESULTS → changed:false', stale.status === 200 && stale.body?.changed === false, stale.body);
    const { data: resettle, error: resettleErr } = await db.rpc('settle_round', { p_round: roundId });
    check('settle_round called again pays 0', !resettleErr && resettle === 0, resettleErr ?? resettle);
    const { data: payouts } = await db.from('token_ledger').select('player_id, delta').eq('round_id', roundId).eq('type', 'payout');
    const winners = bets.filter((b) => b.side === winner);
    check(`ledger r1: exactly ${winners.length} payout rows (2× stake each)`,
      payouts?.length === winners.length && winners.every((w) => payouts.some((p) => p.player_id === w.p.id && p.delta === 2 * w.stake)), payouts);
    const adv = await Promise.all([
      call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'RESULTS' } }),
      call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'RESULTS' } }),
    ]);
    const s2 = await state();
    check('advance from RESULTS twice → exactly one new round', s2?.game?.roundNumber === 2 && adv.filter((a) => a.body?.changed === true).length === 1,
      { roundNumber: s2?.game?.roundNumber, responses: adv.map((a) => a.body) });
    await ledgerInvariant('after re-settle attempts');

    // ================= ROUNDS 2-5 via tick only =================
    const broke = daveSide === winner ? erin : dave;
    const rich = broke === dave ? erin : dave;
    for (let r = 2; r <= 5; r++) {
      await tickUntil(at(r, ['BETTING']), `BETTING r${r}`);
      const rid: string = (await state()).round.id;
      if (r === 2) {
        const zero = await call('POST', '/api/bet', { token: broke.token, body: { roundId: rid, side: 'A', stake: 1 } });
        const bm = (await state(broke.token))?.me;
        check(`0-token player (${broke.name}) can't bet → INSUFFICIENT_TOKENS`, bm?.tokens === 0 && zero.status === 409 && errCode(zero) === 'INSUFFICIENT_TOKENS' && bm?.bet === null,
          { tokens: bm?.tokens, response: zero.body });
      }
      const roundBets: { p: Player; side: 'A' | 'B'; stake: number }[] = [
        { p: alice, side: r % 2 ? 'A' : 'B', stake: 10 },
        { p: bob, side: r % 2 ? 'B' : 'A', stake: 15 },
        { p: rich, side: 'A', stake: 25 },
      ];
      let ok = true;
      for (const b of roundBets) {
        const resp = await call('POST', '/api/bet', { token: b.p.token, body: { roundId: rid, side: b.side, stake: b.stake } });
        if (resp.status !== 200) { ok = false; console.log(ts(), `   bet ${b.p.name} failed`, resp.status, JSON.stringify(resp.body)); }
        else expected[b.p.id] -= b.stake;
      }
      check(`round ${r}: 3 bets accepted`, ok);
      const res = await tickUntil(at(r, ['RESULTS', 'CANCELLED']), `RESULTS r${r}`);
      const w: 'A' | 'B' = res.round.winner;
      check(`round ${r} reached RESULTS with a winner`, res.round.phase === 'RESULTS' && (w === 'A' || w === 'B'), { phase: res.round.phase, winner: w });
      if (ok) for (const b of roundBets) if (b.side === w) expected[b.p.id] += 2 * b.stake;
      await ledgerInvariant(`round ${r} (winner ${w})`);
    }

    // ---------- GAME_OVER, and a 6th start/advance/tick changes nothing ----------
    const over5 = await tickUntil((s) => s?.game?.status === 'GAME_OVER', 'GAME_OVER');
    check('after round 5 → GAME_OVER', over5.game.status === 'GAME_OVER' && over5.game.roundNumber === 5, over5.game);
    const sixth = await call('POST', '/api/admin/start', { admin: true });
    const advAgain = await call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'RESULTS' } });
    const tickAgain = await tick();
    check('6th start / advance / tick after GAME_OVER → 200, changed:false',
      [sixth, advAgain, tickAgain].every((x) => x.status === 200 && x.body?.changed === false), [sixth.body, advAgain.body, tickAgain.body]);
    const after = await state();
    const { data: rounds } = await db.from('rounds').select('round_number').eq('game_id', gameId);
    const { count: unused } = await db.from('cases').select('id', { count: 'exact', head: true }).is('used_at', null);
    check('still GAME_OVER, exactly 5 rounds in DB, 1 case unused', after?.game?.status === 'GAME_OVER' && rounds?.length === 5 && unused === 1,
      { status: after?.game?.status, rounds: rounds?.map((x) => x.round_number), unusedCases: unused });
    await ledgerInvariant('final');
    const lb = await call('GET', '/api/leaderboard');
    check('leaderboard lists all players, sorted by tokens', lb.status === 200 && players.every((p) => lb.body?.players?.some((e: any) => e.nickname === p.name)) &&
      lb.body.players.every((e: any, i: number, arr: any[]) => i === 0 || arr[i - 1].tokens >= e.tokens), lb.body?.players?.slice(0, 6));
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL  simulation aborted:', e instanceof Error ? e.message : e); process.exit(1); });
