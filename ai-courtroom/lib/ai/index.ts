// lib/ai/index.ts — Dev 3's server-only adapter around Dev 1's AI engine (../ai, imported as "@courtroom/ai").
// Do NOT change the engine from here; this file only picks live vs mock and re-exports what the game engine needs.
//
//   AI_MODE=live  -> real Claude calls (needs ANTHROPIC_API_KEY; models/effort from ai/src/config.ts defaults or env)
//   anything else -> Dev 1's engine with a fake model provider (no key, no cost, same state/validation code paths)
import 'server-only';
import { createAiRound, type AiRound } from '@courtroom/ai';
import { mockGenerate } from './mock';

export {
  startRound, parseRoundState, serializeRound, publicRoundView,
} from '@courtroom/ai';
export type {
  AiRound, AiRoundState, AiError, AudienceSubmission, PublicArgument, PublicRoundView, JudgeVerdict, Scenario,
} from '@courtroom/ai';

export const aiMode = (): 'live' | 'mock' => (process.env.AI_MODE === 'live' ? 'live' : 'mock');

// One engine per server instance. Created lazily so env vars are read at first use, not at import.
let engine: AiRound | null = null;
export function getAi(): AiRound {
  if (!engine) {
    engine = aiMode() === 'live'
      ? createAiRound()                                    // production defaults (Sonnet 5.5, low effort)
      : createAiRound(undefined, { generate: mockGenerate });
  }
  return engine;
}
