import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { getUser } from '@/lib/supabase/auth';
import { fail, fromDbError } from '@/lib/game/errors';

const Body = z.object({
  roundId: z.string().uuid(),
  // z.literal(1) accepts ONLY the number 1. union = "either of these".
  window: z.union([z.literal(1), z.literal(2)]),
  text: z.string().trim().min(1).max(250),
});
// NOTE: there is no `side` field. The side is looked up from the player's bet in SQL,
// so a player can't coach the side they didn't bet on.

export async function POST(req: Request) {
  const user = await getUser(req);
  if (!user) return fail('UNAUTHENTICATED', 401);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400, 'Clue must be 1-250 characters');

  const { roundId, window, text } = parsed.data;

  // submit_injection checks: correct INJECT_n phase, server-time deadline, has a bet,
  // length, and one clue per window (unique constraint).
  const { data, error } = await db.rpc('submit_injection', {
    p_player: user.id,
    p_round: roundId,
    p_window: window,
    p_text: text,
  });
  if (error) return fromDbError(error); // INJECTION_CLOSED, NO_BET, ALREADY_INJECTED

  return NextResponse.json({ accepted: true, injectionId: data as string });
}