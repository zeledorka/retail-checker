// app/api/admin/start/route.ts
import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/supabase/auth';
import { setAutopilot, startGame } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';

export async function POST(req: Request) {
  // isAdmin compares the "x-admin-secret" header with ADMIN_SECRET in .env (Vercel env vars when deployed).
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  try {
    const res = await startGame();
    // Starting a game turns server-side autopilot on (GET /api/state polls drive it). Host can turn it off via
    // POST /api/admin/autopilot { enabled: false } and use advance/tick manually.
    await setAutopilot(true);
    return NextResponse.json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
