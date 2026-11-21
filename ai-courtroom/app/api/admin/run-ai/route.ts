// app/api/admin/run-ai/route.ts — the host's "Retry AI" button
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdmin } from '@/lib/supabase/auth';
import { runAiStep, ALL_PHASES } from '@/lib/game/engine';
import { fail } from '@/lib/game/errors';

export const maxDuration = 60;

const Body = z.object({ roundId: z.string().uuid(), expectedPhase: z.enum(ALL_PHASES) });

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400);
  try {
    const result = await runAiStep(parsed.data.roundId, parsed.data.expectedPhase);
    return NextResponse.json(result);           // { status: 'done' } or { status: 'skipped' }
  } catch (e) {
    // Admin-only endpoint, so showing the real error message to the host is fine and helpful.
    return NextResponse.json({ status: 'failed', error: String(e) }, { status: 502 });
  }
}