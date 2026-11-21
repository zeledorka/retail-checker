"use client";
import { useEffect, useState } from "react";
import type { UiGameState } from "@/lib/types";

/**
 * FALLBACK ONLY, for when the server does not expose me.tokensBefore / me.roundDelta.
 * Remembers the server-reported balance the first time we see this round BEFORE the player has bet
 * (reveal / betting), keyed by round id in localStorage so it survives refreshes.
 * Then delta = (server balance now) - (server balance before the round). No payout maths on the client.
 * TODO: confirm with Dev 3 that /api/state returns me.tokensBefore + me.roundDelta, then this can go.
 */
export function useRoundBaseline(state: UiGameState | null): number | null {
  const roundId = state?.round?.id ?? null;
  const me = state?.me ?? null;
  const phase = state?.phase;
  const [baseline, setBaseline] = useState<number | null>(null);

  useEffect(() => {
    if (!roundId || !me) { setBaseline(null); return; }
    const key = `aic:baseline:${roundId}`;
    let stored = localStorage.getItem(key);
    if (stored === null && !me.bet && (phase === "reveal" || phase === "betting")) {
      stored = String(me.tokens);
      localStorage.setItem(key, stored);
    }
    setBaseline(stored === null ? null : Number(stored));
  }, [roundId, me, phase]);

  return baseline;
}
