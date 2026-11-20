import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { buildState } from '@/lib/game/state';
import { fail } from '@/lib/game/errors';

// Next.js may CACHE GET routes. This line forces a fresh response every call.
// Without it, players could see stale phases.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    // Auth is OPTIONAL here: the projector has no player. getUser returns null in that case.
    const user = await getUser(req);
    // `user?.id ?? null` = "user's id if user exists, otherwise null".
    const state = await buildState(user?.id ?? null);
    return NextResponse.json(state);
  } catch (e) {
    console.error('[state]', e);
    return fail('INTERNAL', 500);
  }
}