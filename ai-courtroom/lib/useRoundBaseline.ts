"use client";
import { useEffect, useState } from "react";
import type { UiGameState } from "@/lib/types";

type Stored = { before?: number; preSettle?: number };

/**
 * FALLBACK ONLY, used while the server does not expose me.tokensBefore / me.roundDelta (if they appear, /play prefers them).
 * Remembers server-reported balances for this round in sessionStorage (per round id, survives refresh in this tab):
 *   - before:    the balance seen BEFORE the player bet (reveal / betting, no bet yet)
 *   - preSettle: the balance seen AFTER the bet but before results (stake already deducted by the server)
 * Returns the balance before the round: `before`, else `preSettle + stake` (both are server numbers; no payout maths).
 * Then the UI shows delta = (server balance now) - (balance before the round).
 * Storage is read/written only inside the effect, never during render.
 * TODO: ask Dev 3 for me.tokensBefore + me.roundDelta in /api/state, then this can go.
 */
export function useRoundBaseline(state: UiGameState | null): number | null {
  const roundId = state?.round?.id ?? null;
  const me = state?.me ?? null;
  const phase = state?.phase;
  const [baseline, setBaseline] = useState<number | null>(null);

  useEffect(() => {
    if (!roundId || !me) { setBaseline(null); return; }
    const key = `aic:round-balance:${roundId}`;
    let s: Stored = {};
    try { s = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Stored; } catch { s = {}; }
    let changed = false;
    if (s.before === undefined && !me.bet && (phase === "reveal" || phase === "betting")) { s.before = me.tokens; changed = true; }
    if (s.preSettle === undefined && me.bet && (phase === "betting" || phase === "openings" || phase === "debate" || phase === "judging")) {
      s.preSettle = me.tokens; changed = true;
    }
    if (changed) sessionStorage.setItem(key, JSON.stringify(s));
    const before = s.before ?? (s.preSettle !== undefined && me.bet ? s.preSettle + me.bet.stake : null);
    setBaseline(before);
  }, [roundId, me, phase]);

  return baseline;
}
