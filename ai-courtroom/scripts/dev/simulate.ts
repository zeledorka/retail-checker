/**
 * End-to-end round simulation against a running dev server + the real Supabase DB (mock AI).
 *
 *   npx tsx --env-file=.env scripts/dev/simulate.ts               normal round (server: AI_MODE=mock)
 *   npx tsx --env-file=.env scripts/dev/simulate.ts --judge-fail  server started with MOCK_JUDGE_FAIL=1:
 *                                                                 expects CANCELLED + one refund per bettor
 *   BASE_URL=http://localhost:3001 ...                            other server
 *
 * RESETS THE ACTIVE GAME. Creates 3 anonymous Supabase users per run. Prints PASS/FAIL per check, exits 1 on any FAIL.
 */
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN = process.env.ADMIN_SECRET;
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const JUDGE_FAIL = process.argv.includes('--judge-fail');
const ROUND_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
let failures = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  if (!ok) failures++;
  const d = detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`);
}

type Res = { status: number; body: any };
async function call(method: string, path: string, opts: { token?: string; admin?: boolean; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.admin) headers['x-admin-secret'] = ADMIN!;
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

/** Tick once a second until the current round reaches `phase` (or any of `orPhases`). Returns the reached phase. */
async function tickUntil(phases: string[], label: string): Promise<string> {
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const t = await tick();
    if (t.status !== 200) console.log(ts(), `   tick HTTP ${t.status}`, JSON.stringify(t.body));
    if (t.body?.ai?.status === 'failed') console.log(ts(), '   AI failed:', t.body.ai.error);
    const s = await state();
    const phase = s?.round?.phase ?? '(none)';
    if (phase !== last) { console.log(ts(), `── ${phase}`); last = phase; }
    if (phases.includes(phase)) return phase;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label} (last phase ${last})`);
}

async function main() {
  for (const [k, v] of Object.entries({ ADMIN_SECRET: ADMIN, NEXT_PUBLIC_SUPABASE_URL: URL_, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SECRET_KEY: SECRET })) {
    if (!v) throw new Error(`${k} missing: run with --env-file=.env`);
  }
  const db = createClient(URL_!, SECRET!, { auth: { persistSession: false } });   // read-only checks of ledger/verdicts
  console.log(`simulate: ${BASE} mode=${JUDGE_FAIL ? 'judge-fail' : 'normal'}`);

  // ---------- setup ----------
  const reset = await call('POST', '/api/admin/reset', { admin: true });
  check('reset game', reset.status === 200, reset.status === 200 ? '' : reset.body);
  if (reset.status !== 200) throw new Error('cannot continue without a reset');
  const [alice, bob, carol] = [await newPlayer('SimAlice'), await newPlayer('SimBob'), await newPlayer('SimCarol')];
  const me0 = (await state(alice.token))?.me;
  check('join: new player has 100 tokens', me0?.tokens === 100, me0);

  const start = await call('POST', '/api/admin/start', { admin: true });
  check('start round 1 → REVEAL', start.status === 200 && start.body?.phase === 'REVEAL', start.body);

  // ---------- BETTING ----------
  await tickUntil(['BETTING'], 'BETTING');
  const roundId: string = (await state()).round.id;
  const STAKE = { alice: 20, bob: 30 };
  const b1 = await call('POST', '/api/bet', { token: alice.token, body: { roundId, side: 'A', stake: STAKE.alice } });
  check('alice bets 20 on A', b1.status === 200 && b1.body?.tokensRemaining === 80, b1.body);
  const b2 = await call('POST', '/api/bet', { token: bob.token, body: { roundId, side: 'B', stake: STAKE.bob } });
  check('bob bets 30 on B', b2.status === 200 && b2.body?.tokensRemaining === 70, b2.body);
  const b3 = await call('POST', '/api/bet', { token: alice.token, body: { roundId, side: 'B', stake: 5 } });
  check('second bet from same player → ALREADY_BET', b3.status === 409 && errCode(b3) === 'ALREADY_BET', b3.body);
  const early = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'too early' } });
  check('inject during BETTING → INJECTION_CLOSED', errCode(early) === 'INJECTION_CLOSED', early.body);

  // ---------- OPENINGS: clue window ----------
  await tickUntil(['OPENINGS', 'DEBATE'], 'OPENINGS');
  const noBet = await call('POST', '/api/inject', { token: carol.token, body: { roundId, text: 'I never bet' } });
  check('inject with no bet → NO_BET', noBet.status === 409 && errCode(noBet) === 'NO_BET', noBet.body);
  const tooLong = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'x'.repeat(201) } });
  check('inject 201 chars → BAD_REQUEST', tooLong.status === 400 && errCode(tooLong) === 'BAD_REQUEST', tooLong.body);
  const clue = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'The lock has no scratches, so a key was used.' } });
  check('alice submits a clue', clue.status === 200 && clue.body?.accepted === true, clue.body);
  const clue2 = await call('POST', '/api/inject', { token: alice.token, body: { roundId, text: 'second clue' } });
  check('second clue same round → ALREADY_INJECTED', clue2.status === 409 && errCode(clue2) === 'ALREADY_INJECTED', clue2.body);
  const meClue = (await state(alice.token))?.me;
  check('state.me shows own bet + clue', meClue?.bet?.side === 'A' && meClue?.bet?.stake === 20 && !!meClue?.injection?.text, meClue);

  // ---------- JUDGING ----------
  const reached = await tickUntil(JUDGE_FAIL ? ['JUDGING', 'CANCELLED'] : ['JUDGING', 'RESULTS'], 'JUDGING');
  check('round reached JUDGING (not skipped)', reached === 'JUDGING', reached);
  if (reached === 'JUDGING') {
    const late = await call('POST', '/api/inject', { token: bob.token, body: { roundId, text: 'too late' } });
    check('inject after its window (JUDGING) → INJECTION_CLOSED', late.status === 409 && errCode(late) === 'INJECTION_CLOSED', late.body);
    const pub = await state();
    const priv = await state(bob.token);
    const leakFree = (s: any) => s?.round?.winner === null && s?.round?.verdict === null && !/"explanation"|"rationale"/.test(JSON.stringify(s));
    check('GET /api/state during JUDGING has no winner/verdict (projector + player)', leakFree(pub) && leakFree(priv), { projector: pub?.round, player: priv?.round?.winner });
    const msgs = (pub?.publicMessages ?? []) as any[];
    check('debate: 2 openings + 8 turns in publicMessages', msgs.filter((m) => m.stage === 'opening').length === 2 && msgs.filter((m) => m.stage === 'turn').length === 8,
      { openings: msgs.filter((m) => m.stage === 'opening').length, turns: msgs.filter((m) => m.stage === 'turn').length });
    check('no audience clue text leaks into public state', !JSON.stringify(pub).includes('The lock has no scratches'));
    if (!JUDGE_FAIL) {
      const { data: v } = await db.from('verdicts').select('winner').eq('round_id', roundId).maybeSingle();
      console.log(ts(), `   (verdict already stored in DB: ${v ? 'yes, hidden from API' : 'not yet'})`);
    }
  }

  if (JUDGE_FAIL) {
    // ---------- judge keeps failing → autopilot cancels + refunds ----------
    const end = await tickUntil(['CANCELLED', 'RESULTS'], 'CANCELLED');
    check('judge failure → round CANCELLED', end === 'CANCELLED', end);
    const [a, b, c] = await Promise.all([state(alice.token), state(bob.token), state(carol.token)]);
    check('stakes refunded (alice 100, bob 100, carol 100)', a?.me?.tokens === 100 && b?.me?.tokens === 100 && c?.me?.tokens === 100,
      { alice: a?.me?.tokens, bob: b?.me?.tokens, carol: c?.me?.tokens });
    const again = await call('POST', '/api/admin/cancel', { admin: true, body: { roundId } });
    check('cancel again refunds nobody', again.status === 200 && again.body?.refunded === 0, again.body);
    await Promise.all([tick(), tick(), tick()]);
    const { data: refunds } = await db.from('token_ledger').select('player_id, delta').eq('round_id', roundId).eq('type', 'refund');
    check('exactly one refund row per bettor', refunds?.length === 2 && refunds.every((r) => (r.player_id === alice.id && r.delta === 20) || (r.player_id === bob.id && r.delta === 30)), refunds);
    const after = await Promise.all([state(alice.token), state(bob.token)]);
    check('balances unchanged after duplicate cancel/ticks', after[0]?.me?.tokens === 100 && after[1]?.me?.tokens === 100, after.map((s) => s?.me?.tokens));
    const { data: ver } = await db.from('verdicts').select('round_id').eq('round_id', roundId);
    check('no verdict stored for the cancelled round', (ver ?? []).length === 0, ver);
  } else {
    // ---------- duplicate ticks while JUDGING is done: settle must pay once ----------
    const dup = await Promise.all([tick(), tick(), tick(), tick()]);
    check('4 concurrent ticks during JUDGING all succeed', dup.every((d) => d.status === 200), dup.map((d) => d.status));
    const end = await tickUntil(['RESULTS'], 'RESULTS');
    const pub = await state();
    const winner: 'A' | 'B' | undefined = pub?.round?.winner;
    check('RESULTS reveals winner + verdict', end === 'RESULTS' && (winner === 'A' || winner === 'B') && !!pub?.round?.verdict?.explanation, pub?.round?.verdict);
    const expected = {
      alice: winner === 'A' ? 100 - STAKE.alice + 2 * STAKE.alice : 100 - STAKE.alice,
      bob: winner === 'B' ? 100 - STAKE.bob + 2 * STAKE.bob : 100 - STAKE.bob,
      carol: 100,
    };
    const tokens = async () => {
      const [a, b, c] = await Promise.all([state(alice.token), state(bob.token), state(carol.token)]);
      return { alice: a?.me?.tokens, bob: b?.me?.tokens, carol: c?.me?.tokens };
    };
    const t1 = await tokens();
    check(`winner (${winner}) gained exactly 2× stake, loser + non-bettor nothing`, JSON.stringify(t1) === JSON.stringify(expected), { got: t1, expected });

    // settle again in every way we can: stale advance, direct RPC, more ticks, double advance from RESULTS
    const stale = await call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'JUDGING' } });
    check('stale advance(JUDGING) in RESULTS → changed:false', stale.status === 200 && stale.body?.changed === false, stale.body);
    const { data: resettle, error: resettleErr } = await db.rpc('settle_round', { p_round: roundId });
    check('settle_round called again pays 0', !resettleErr && resettle === 0, resettleErr ?? resettle);
    const adv = await Promise.all([
      call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'RESULTS' } }),
      call('POST', '/api/admin/advance', { admin: true, body: { expectedPhase: 'RESULTS' } }),
    ]);
    const s2 = await state();
    check('advance from RESULTS twice → exactly one new round', s2?.game?.roundNumber === 2 && adv.filter((a) => a.body?.changed === true).length === 1,
      { roundNumber: s2?.game?.roundNumber, responses: adv.map((a) => a.body) });
    const t2 = await tokens();
    check('balances unchanged after re-settle attempts', JSON.stringify(t2) === JSON.stringify(expected), t2);
    const { data: payouts } = await db.from('token_ledger').select('player_id, delta').eq('round_id', roundId).eq('type', 'payout');
    const winnerId = winner === 'A' ? alice.id : bob.id;
    const winnerStake = winner === 'A' ? STAKE.alice : STAKE.bob;
    check('ledger: exactly one payout row (winner, 2× stake)', payouts?.length === 1 && payouts[0].player_id === winnerId && payouts[0].delta === 2 * winnerStake, payouts);
    // leave the game parked: cancel round 2 (no bets) so nothing keeps running
    if (s2?.round?.id) await call('POST', '/api/admin/cancel', { admin: true, body: { roundId: s2.round.id } });
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL  simulation aborted:', e instanceof Error ? e.message : e); process.exit(1); });
