import { NextResponse, connection } from 'next/server';
import { getLeaderboard } from '@/lib/game/state';
import { fail } from '@/lib/game/errors';

export async function GET() {
  // This one matters most: it reads no request data, so without connection()
  // Next.js could pre-build it ONCE at build time and serve a frozen leaderboard forever.
  await connection();
  try {
    return NextResponse.json({ players: await getLeaderboard() });
  } catch (e) {
    console.error('[leaderboard]', e);
    return fail('INTERNAL', 500);
  }
}