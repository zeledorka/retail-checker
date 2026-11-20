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


// Turn a Supabase/Postgres error into a friendly API error.
export function fromDbError(e: { code?: string; message: string }) {
  // 23505 = Postgres "unique constraint violated". This happens when two requests race,
  // e.g. the same player double-taps "Bet". The database rejected the second one.
  if (e.code === '23505') {
    return fail(e.message.includes('injections') ? 'ALREADY_INJECTED' : 'ALREADY_BET', 409);
  }

  // Find the error code from our list above, and return the error message corresponding.
  const code = KNOWN_DB_CODES.find((known) => e.message.includes(known));
  if (code) return fail(code, 409); // 409 = "Conflict" (request valid, but state says no)

  // Anything else is a bug or outage. Log it on the server so you can see it in
  // the terminal / Vercel logs, and prevent these details from being seen by Players.
  console.error('[db error]', e);
  return fail('INTERNAL', 500, 'Something went wrong');
}