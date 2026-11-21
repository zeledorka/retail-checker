// lib/ai/index.ts
// The ONE thing the rest of the app imports from lib/ai.
// `CourtroomAI` (from types/game.ts) is an interface: a contract listing the three
// functions and their exact inputs/outputs. Assigning mockAI to it makes TS check that
// the mock really matches the contract. Dev 1's live version must match it too.
import type { CourtroomAI } from '@/types/game';
import { mockAI } from './mock';

// Dev 1 changes this line to something like:
//   export const ai: CourtroomAI = process.env.AI_MODE === 'live' ? liveAI : mockAI;
export const ai: CourtroomAI = mockAI;