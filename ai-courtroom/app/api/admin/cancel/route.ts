// app/api/admin/cancel/route.ts
// For cancelling a round
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdmin } from '@/lib/supabase/auth';
import { cancelRound } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';

const Body = z.object({ roundId: z.string().uuid() });

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400);
  try {
    const refunded = await cancelRound(parsed.data.roundId);
    return NextResponse.json({ cancelled: true, refunded });
  } catch (e) {
    return toErrorResponse(e);
  }
}