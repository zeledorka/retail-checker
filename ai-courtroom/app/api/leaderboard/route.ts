import { NextResponse } from 'next/server';
import { getLeaderboard } from '@/lib/game/state';
import { fail } from '@/lib/game/errors';

export const dynamic = 'force-dynamic';

export async function GET() {   // no `req` parameter needed: public, no auth
  try {
    return NextResponse.json({ players: await getLeaderboard() });
  } catch (e) {
    console.error('[leaderboard]', e);
    return fail('INTERNAL', 500);
  }
}