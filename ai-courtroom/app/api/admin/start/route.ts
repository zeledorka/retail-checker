// app/api/admin/start/route.ts
import { NextResponse } from 'next/server';
import { isAdmin } from '@/lib/supabase/auth';
import { startGame } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';

export async function POST(req: Request) {
  // isAdmin compares the "x-admin-secret" header with ADMIN_SECRET in .env (Vercel env vars when deployed).
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  try {
    return NextResponse.json(await startGame());
  } catch (e) {
    return toErrorResponse(e);
  }
}