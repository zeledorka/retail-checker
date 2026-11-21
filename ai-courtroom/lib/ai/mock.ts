// lib/ai/mock.ts — fake AI so the whole game works without any API key
import type { AgentLine, CourtroomAI, Side, Stage } from '@/types/game';

// A Promise that resolves after `ms` milliseconds. Used to fake model "thinking" time,
// so the frontend's "Agents thinking…" state gets exercised.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Small helper to build an AgentLine without repeating the field names everywhere.
const line = (side: Side, stage: Stage, text: string): AgentLine => ({ side, stage, text });

export const mockAI: CourtroomAI = {
  // `async generateOpening({ caseData })` = a method that receives one object and
  // immediately pulls out its `caseData` property (destructuring in the parameter list).
  async generateOpening({ caseData }) {
    await sleep(800);
    return {
      A: line('A', 'opening', `Defence A: the evidence shows ${caseData.hypothesisA}`),
      B: line('B', 'opening', `Defence B: clearly ${caseData.hypothesisB}`),
    };
  },

  async generatePair({ selectedClues, stage }) {
    await sleep(1200);
    // Echo the first audience tip so you can SEE clues reaching the right side.
    // `?.text ?? '...'`: if there is no first clue, use the fallback text.
    const tip = (s: Side) => selectedClues[s][0]?.text ?? 'no audience tips this time';
    return {
      A: line('A', stage, `[A ${stage}] Taking the gallery's advice: "${tip('A')}"`),
      B: line('B', stage, `[B ${stage}] My supporters say: "${tip('B')}"`),
    };
  },

  async judge({ transcript }) {
    await sleep(1500);
    // Lets you test the "judge failed → retry / cancel + refund" path.
    // Set MOCK_JUDGE_FAIL=1 in .env.local and restart `npm run dev`.
    if (process.env.MOCK_JUDGE_FAIL === '1') throw new Error('Mock judge failure');

    // `const winner: Side = ...` annotates the type so TS knows it's 'A' | 'B', not string.
    const winner: Side = Math.random() < 0.5 ? 'A' : 'B';
    return {
      winner,
      rationale: `Mock ruling: ${winner} tied claims to evidence more consistently across ${transcript.length} statements.`,
      scores: { A: winner === 'A' ? 7 : 5, B: winner === 'B' ? 7 : 5 },
    };
  },
};