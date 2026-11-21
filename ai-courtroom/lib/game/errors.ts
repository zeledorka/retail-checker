// Next.js's helper for building HTTP responses from route handlers.
import { NextResponse } from 'next/server';
//ErrorCode is the union of allowed error strings defined in types/game.ts (e.g. 'BETTING_CLOSED' | 'NO_BET' | ...).
import type { ErrorCode } from '@/types/game';

/**
 * Build a JSON error response in the shape every route uses:
 *   { "error": { "code": "BETTING_CLOSED", "message": "BETTING_CLOSED" } }
 */
export function fail(code: ErrorCode, status = 400, message: string = code) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Error codes the SQL functions raise with `raise exception 'XYZ'`.
// These are the key searchwords inside the database error message.
const KNOWN_DB_CODES: ErrorCode[] = [
  'BETTING_CLOSED', 'ALREADY_BET', 'INSUFFICIENT_TOKENS',
  'INJECTION_CLOSED', 'NO_BET', 'BAD_REQUEST', 'NO_CASES_LEFT',
];

// SQL codes that need a different API code and/or HTTP status than the default 409.
// Checked BEFORE KNOWN_DB_CODES. ROUND_NOT_FOUND / NO_VERDICT are internal SQL names, not API codes.
const SPECIAL_DB_CODES: Record<string, { code: ErrorCode; status: number; message: string }> = {
  NOT_JOINED: { code: 'NOT_JOINED', status: 403, message: 'Join the game first (POST /api/join)' },
  ROUND_NOT_FOUND: { code: 'BAD_REQUEST', status: 404, message: 'Round not found' },
  NO_VERDICT: { code: 'AI_NOT_DONE', status: 409, message: 'No verdict stored yet' },
};


// Turn a Supabase/Postgres error into a friendly API error.
export function fromDbError(e: { code?: string; message: string }) {
  // 23505 = Postgres "unique constraint violated". This happens when two requests race,
  // e.g. the same player double-taps "Bet". The database rejected the second one.
  if (e.code === '23505') {
    return fail(e.message.includes('injections') ? 'ALREADY_INJECTED' : 'ALREADY_BET', 409);
  }

  const special = Object.keys(SPECIAL_DB_CODES).find((k) => e.message.includes(k));
  if (special) {
    const s = SPECIAL_DB_CODES[special];
    return fail(s.code, s.status, s.message);
  }

  // Find the error code from our list above, and return the error message corresponding.
  const code = KNOWN_DB_CODES.find((known) => e.message.includes(known));
  if (code) return fail(code, 409); // 409 = "Conflict" (request valid, but state says no)

  // Anything else is a bug or outage. Log it on the server so you can see it in
  // the terminal / Vercel logs, and prevent these details from being seen by Players.
  console.error('[db error]', e);
  return fail('INTERNAL', 500, 'Something went wrong');
}

/**
 * A custom error type for "expected" game-rule failures (not bugs).
 *
 * `class X extends Error` = make a new kind of Error that has extra fields.
 *  This `new GameError('AI_NOT_DONE')` gives an object with .code = 'AI_NOT_DONE', .status = 409.
 */
export class GameError extends Error {
  constructor(public code: ErrorCode, public status = 409, message: string = code) {
    super(message); // `super(...)` calls the parent (Error) constructor, which sets .message
  }
}

/**
 * Convert ANY thrown thing into an HTTP response. Routes use this in their catch blocks.
 * `unknown` is the safe "could be anything" type: TS forces you to check before using it.
 */
export function toErrorResponse(e: unknown) {
  // check if this error is a GameError instance
  if (e instanceof GameError) return fail(e.code, e.status, e.message);

  // Supabase errors are plain objects with a `message` property.
  // `'message' in e` checks the property exists, so TS lets us treat it as one.
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return fromDbError(e as { code?: string; message: string });
  }

  console.error('[unexpected]', e);
  return fail('INTERNAL', 500);
}