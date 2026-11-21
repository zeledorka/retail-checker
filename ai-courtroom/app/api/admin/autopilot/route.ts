// app/api/admin/autopilot/route.ts: turn server-side autopilot on/off. While on, GET /api/state polls advance the game
// (see autopilotDue in lib/game/engine.ts), so nobody has to call /api/admin/tick from a browser or script.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdmin } from '@/lib/supabase/auth';
import { setAutopilot } from '@/lib/game/engine';
import { fail, toErrorResponse } from '@/lib/game/errors';
import type { AutopilotResponse } from '@/types/game';

const Body = z.object({ enabled: z.boolean() });

export async function POST(req: Request) {
  if (!isAdmin(req)) return fail('FORBIDDEN', 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail('BAD_REQUEST', 400);
  try {
    return NextResponse.json<AutopilotResponse>({ autopilot: await setAutopilot(parsed.data.enabled) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
