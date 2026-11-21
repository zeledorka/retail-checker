// app/api/admin/advance/route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdmin } from '@/lib/supabase/auth';
import { advance, ALL_PHASES } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';

// Vercel: allow this function up to 60s, because entering an AI phase runs the AI.
export const maxDuration = 60;

// z.enum(ALL_PHASES) only accepts one of the real phase names.
const Body = z.object({ expectedPhase: z.enum(ALL_PHASES) });

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400);
  try {
    return NextResponse.json(await advance(parsed.data.expectedPhase));
  } catch (e) {
    return toErrorResponse(e);   // e.g. AI_NOT_DONE → 409
  }
}