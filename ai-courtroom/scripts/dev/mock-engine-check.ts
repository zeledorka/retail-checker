/**
 * Offline check: runs one full round through Dev 1's engine with OUR mock provider (lib/ai/mock.ts).
 * No Supabase, no API key.   npx tsx --conditions=react-server scripts/dev/mock-engine-check.ts
 */
process.env.MOCK_AI_DELAY_MS = '0';
import { getAi, startRound, parseRoundState, serializeRound, publicRoundView, type AudienceSubmission } from '../../lib/ai';

async function main() {
  const ai = getAi();
  const s0 = startRound({ roundId: 'check-round-1', maxTurns: 8, scenario: {
    title: 'The Empty Display Case', description: 'A museum alarm sounded at 2 a.m.; a case was found open and empty.',
    evidence: ['The alarm sounded at 2 a.m.', 'No sign of forced entry'],
    interpretationA: 'An opportunistic theft.', interpretationB: 'A theft staged for insurance.' } });
  if (!s0.ok) throw new Error(s0.error.message);
  let raw = serializeRound(s0.state);
  const load = () => { const r = parseRoundState(raw); if (!r.ok) throw new Error(r.error.message); return r.state; };
  for (const side of ['A', 'B'] as const) {
    const st = await ai.generateOpening(load(), side);
    if (!st.ok) throw new Error(`opening ${side}: ${st.error.message}`);
    raw = serializeRound(st.state); console.log(st.argument.sequence, st.argument.side, st.argument.text);
  }
  const subs: AudienceSubmission[] = [];
  for (let n = 1; n <= 8; n++) {
    if (n === 3) subs.push({ id: 'i1', playerId: 'p1', side: 'A', text: 'Point at the door sensor log', submittedAt: new Date().toISOString() },
                           { id: 'i2', playerId: 'p2', side: 'B', text: 'Mention the insurance renewal', submittedAt: new Date().toISOString() });
    const s = load();
    const st = await ai.nextTurn(s, { submissions: subs, turn: s.transcript.length + 1 });
    if (!st.ok) throw new Error(`turn ${n}: ${st.error.code} ${st.error.message}`);
    raw = serializeRound(st.state); console.log(st.argument.sequence, st.argument.side, st.argument.text);
  }
  const j = await ai.judge(load());
  if (!j.ok) throw new Error(`judge: ${j.error.message}`);
  raw = serializeRound(j.state);
  console.log('winner', j.verdict.winner, '| complete', j.complete, '| status', publicRoundView(load()).status);
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
