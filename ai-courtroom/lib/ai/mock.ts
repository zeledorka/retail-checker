// lib/ai/mock.ts — a fake MODEL PROVIDER for Dev 1's engine (adapted from ai/examples/mock-round.ts).
// The real engine still runs: state, ordering, word limits, audience grouping and verdict validation are all
// exercised. Only the network call to Claude is replaced. No API key, no cost.
//
//   MOCK_AI_DELAY_MS=800   fake "thinking" time per call (default 800)
//   MOCK_JUDGE_FAIL=1      the judge always fails -> test retry / cancel + refund
import 'server-only';
import type { GenerateTextFn } from '@courtroom/ai';
import { JUDGE_SYSTEM } from '@courtroom/ai/prompts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const mockGenerate: GenerateTextFn = async (cfg, req) => {
  await sleep(Number(process.env.MOCK_AI_DELAY_MS ?? 800));
  const isJudge = req.system === JUDGE_SYSTEM;
  const side = req.system.includes('You are Agent A') ? 'A' : 'B';

  if (isJudge) {
    if (process.env.MOCK_JUDGE_FAIL === '1') {
      return { ok: false, error: { kind: 'provider_error', message: 'Mock judge failure (MOCK_JUDGE_FAIL=1)', retryable: true } };
    }
    // Random winner, with scores that agree with it (the engine rejects a winner that contradicts the totals).
    const winner = Math.random() < 0.5 ? 'A' : 'B';
    const strong = { evidence: 7, logic: 7, rebuttal: 8, persuasion: 7 };
    const weak = { evidence: 6, logic: 6, rebuttal: 6, persuasion: 6 };
    const text = JSON.stringify({
      winner,
      explanation: `Mock ruling: Agent ${winner} answered the opponent's strongest point more directly.`,
      summary: `Agent ${winner} rebutted more directly.`,
      scores: { A: winner === 'A' ? strong : weak, B: winner === 'B' ? strong : weak },
      strengths: { A: ['Clear framing'], B: ['Clear framing'] },
      weaknesses: { A: ['Some assumption'], B: ['Some assumption'] },
      references: [{ ref: 'E1', side: 'A', note: 'opening sets the frame' }],
      unsupportedAssumptions: [],
      decisiveExchange: { refs: ['E1', 'E2'], description: 'the openings' },
    });
    return { ok: true, result: { text, provider: 'anthropic', model: `mock:${cfg.model}`, latencyMs: 5, inputTokens: 1000, outputTokens: 100 } };
  }

  // A debate turn WITH audience submissions must return structured JSON grouping the audience themes.
  if (req.system.includes('Output format for this turn')) {
    const line = req.prompt.split('\n').find((l) => l.startsWith('{"themes"'));
    const ids = line ? (JSON.parse(line) as { themes: { id: string }[] }).themes.map((t) => t.id) : [];
    const text = JSON.stringify({
      argument: `[Mock ${side}] My supporters raise a fair point: the evidence fits my reading better than my opponent's inference.`,
      audienceAnalysis: { groups: ids.length ? [{ label: 'Main idea', wordingIds: ids.join(' '), relevance: 'high', used: true }] : [], unassigned: {} },
    });
    return { ok: true, result: { text, provider: 'anthropic', model: `mock:${cfg.model}`, latencyMs: 5, inputTokens: 1000, outputTokens: 100 } };
  }

  // Opening, or a turn with no audience: plain text.
  const text = `[Mock ${side}] The evidence supports my reading, and my opponent's inference does not follow from it.`;
  return { ok: true, result: { text, provider: 'anthropic', model: `mock:${cfg.model}`, latencyMs: 5, inputTokens: 1000, outputTokens: 100 } };
};
