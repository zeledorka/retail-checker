// `connection` is the cacheComponents-friendly way to say "never cache this route".
import { NextResponse, connection } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { buildState } from '@/lib/game/state';
import { fail } from '@/lib/game/errors';

// (removed: export const dynamic = 'force-dynamic'; not allowed with cacheComponents)

export async function GET(req: Request) {
  await connection(); // must run on every request: live game state
  try {
    const user = await getUser(req);
    const state = await buildState(user?.id ?? null);
    return NextResponse.json(state);
  } catch (e) {
    console.error('[state]', e);
    return fail('INTERNAL', 500, process.env.NODE_ENV === 'production' ? 'Something went wrong' : String((e as Error)?.message ?? e));
  }
}