import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { getUser } from '@/lib/supabase/auth';
import { fail, fromDbError } from '@/lib/game/errors';

const Body = z.object({
  roundId: z.string().uuid(),                 // must look like a UUID
  side: z.enum(['A', 'B']),                    // only these two strings allowed
  stake: z.number().int().positive().max(1_000_000), // whole number 1..1,000,000 (balance is checked in SQL; cap avoids int overflow)
});

export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return fail('UNAUTHENTICATED', 401);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400);

  // Destructuring: pull fields out of an object into local variables.
  const { roundId, side, stake } = parsed.data;

  // ALL the important rules (phase, deadline, balance, one bet per round, ledger entry)
  // happen inside ONE database transaction in the place_bet SQL function.
  // That is what makes it safe against double-taps and races: never re-check them here in TS.
  //
  // Notice: the player id comes from the verified token (user.id), NOT from the request body.
  // A player can't bet on someone else's behalf.
  const { data, error } = await db.rpc('place_bet', {
    p_player: user.id,
    p_round: roundId,
    p_side: side,
    p_stake: stake,
  });
  if (error) return fromDbError(error); // e.g. BETTING_CLOSED, INSUFFICIENT_TOKENS, ALREADY_BET

  // place_bet returns the new token balance.
  return NextResponse.json({ accepted: true, tokensRemaining: data as number });
}