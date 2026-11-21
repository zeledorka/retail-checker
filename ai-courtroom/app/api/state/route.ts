// `connection` is the cacheComponents-friendly way to say "never cache this route".
import { NextResponse, after, connection } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { buildState } from '@/lib/game/state';
import { autopilotDue, tick } from '@/lib/game/engine';
import { fail } from '@/lib/game/errors';

// (removed: export const dynamic = 'force-dynamic'; not allowed with cacheComponents)

// Autopilot may run one AI call (after the response, via after()), which can take up to ~40s for the judge.
export const maxDuration = 60;

export async function GET(req: Request) {
  await connection(); // must run on every request: live game state
  try {
    const user = await getUser(req);
    const state = await buildState(user?.id ?? null);
    // Server-side autopilot: if this poll finds the game due for a step, do it AFTER the response is sent
    // (Vercel keeps the function alive for it, up to maxDuration). Many polls may schedule a tick at once:
    // tick() is safe to overlap (phase changes are compare-and-set, AI calls take a per-round lease).
    if (autopilotDue(state)) {
      after(() =>
        tick()
          .then((r) => { if (r.changed || (r.ai && r.ai.status !== 'skipped')) console.log('[autopilot]', JSON.stringify(r)); })
          .catch((e) => console.error('[autopilot] tick failed', e)),
      );
    }
    return NextResponse.json(state);
  } catch (e) {
    console.error('[state]', e);
    return fail('INTERNAL', 500, process.env.NODE_ENV === 'production' ? 'Something went wrong' : String((e as Error)?.message ?? e));
  }
}
