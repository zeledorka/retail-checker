/**
 * Dev autopilot: calls POST /api/admin/tick once a second and prints what happens, so a whole round
 * (REVEAL → BETTING → OPENINGS → 8 DEBATE turns → JUDGING → RESULTS → next round) runs without clicking.
 * This is what the /admin page will do in the browser.
 *
 *   npx tsx --env-file=.env scripts/dev/autopilot.ts            (needs `npm run dev` running)
 *   BASE_URL=https://your-app.vercel.app npx tsx --env-file=.env scripts/dev/autopilot.ts
 *
 * Bet / inject from requests.http while it runs (BETTING is 15s; clues are accepted during OPENINGS and DEBATE).
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) throw new Error('ADMIN_SECRET missing: run with --env-file=.env');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let lastPhase: string | null = null;
  for (;;) {
    const res = await fetch(`${BASE}/api/admin/tick`, { method: 'POST', headers: { 'x-admin-secret': SECRET! } });
    const body = await res.json().catch(() => ({}));
    const t = new Date().toISOString().slice(11, 19);
    if (!res.ok) console.log(t, 'HTTP', res.status, JSON.stringify(body));
    else {
      if (body.phase !== lastPhase) { console.log(t, '── phase:', body.phase); lastPhase = body.phase; }
      if (body.ai?.message) console.log(t, '   AI:', body.ai.message);
      if (body.ai?.status === 'failed') console.log(t, '   AI FAILED:', body.ai.error);
    }
    const state = await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => null);
    if (state?.game?.status === 'GAME_OVER') { console.log(t, 'GAME_OVER'); break; }
    if (state?.round?.phase === 'RESULTS' && state.round.verdict && body.changed) {
      console.log(t, `   VERDICT: Agent ${state.round.verdict.winner}: ${state.round.verdict.explanation}`);
    }
    await sleep(1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
