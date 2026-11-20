import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/supabase/admin';
import { getUser } from '@/lib/supabase/auth';
import { getActiveGame, toPublicGame } from '@/lib/game/state';
import { fail, fromDbError } from '@/lib/game/errors';

/**
 * Zod schema = a runtime validator for the request body.
 * TypeScript types disappear at runtime, so they can't protect you from a malicious
 * request. Zod checks the ACTUAL incoming data.
 *   .trim()        strip spaces around the nickname
 *   .min(1).max(20) must match the DB check constraint
 */
const Body = z.object({
  nickname: z.string().trim().min(1, 'Nickname required').max(20, 'Max 20 characters'),
});

export async function POST(req: Request) {
  // 1) Who is calling? The frontend sends "Authorization: Bearer <token>" from anonymous sign-in.
  const user = await getUser(req);
  if (!user) return fail('UNAUTHENTICATED', 401);

  // 2) Validate the body.
  //    req.json() throws on invalid JSON; .catch(() => null) turns that into null instead.
  //    safeParse never throws; it returns { success: true, data } or { success: false, error }.
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400, parsed.error.issues[0]?.message);

  // 3) Was this player already registered? (e.g. they refreshed the page and re-joined)
  const { data: existing } = await db.from('players').select('id').eq('id', user.id).maybeSingle();

  // 4) Upsert = insert, or update if the id already exists.
  //    We send ONLY id + nickname, so on re-join the nickname changes but tokens do NOT reset.
  //    New rows get tokens = 100 from the column default.
  const { data: player, error } = await db
    .from('players')
    .upsert({ id: user.id, nickname: parsed.data.nickname }, { onConflict: 'id' })
    .select('id, nickname, tokens')
    .single();
  if (error) return fromDbError(error);

  // 5) First-time joiners get a ledger entry recording their starting 100 tokens.
  if (!existing) {
    await db.from('token_ledger').insert({ player_id: user.id, round_id: null, type: 'grant', delta: 100 });
  }

  const game = await getActiveGame();
  return NextResponse.json({ player, game: toPublicGame(game) });
}