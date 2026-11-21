// app/api/admin/reset/route.ts — rehearsals and testing only
import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/supabase/auth';
import { resetGame } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';
import type { ResetResponse } from '@/types/game';

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  try {
    return NextResponse.json<ResetResponse>({ gameId: await resetGame() });
  } catch (e) {
    return toErrorResponse(e);
  }
}