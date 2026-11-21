// app/api/admin/tick/route.ts — autopilot; the admin page calls this every ~1s
import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/supabase/auth';
import { tick } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  try {
    return NextResponse.json(await tick());
  } catch (e) {
    return toErrorResponse(e);
  }
}