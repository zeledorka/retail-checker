// app/api/admin/run-ai/route.ts — the host's "Retry AI" / "next AI step" button.
// Each call makes at most ONE model request (the next opening, the next turn, or the judge) and commits it.
// Unlike the autopilot (tick), this ignores the failure counter, so the host can always retry by hand.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdmin } from '@/lib/supabase/auth';
import { runAiStep, ALL_PHASES } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';

export const maxDuration = 60;   // one call: agent turn ≤ 25s, judge ≤ 40s

const Body = z.object({ roundId: z.string().uuid(), expectedPhase: z.enum(ALL_PHASES) });

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400);
  try {
    // { status: 'progress' | 'done' | 'skipped' | 'failed', message?, error? }
    const result = await runAiStep(parsed.data.roundId, parsed.data.expectedPhase);
    // Admin-only endpoint, so showing the AI error message to the host is fine and helpful.
    return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
