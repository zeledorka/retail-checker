"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getState, friendly } from "@/lib/api";
import type { UiGameState } from "@/lib/types";

const POLL_MS = 2000;

/**
 * Server is the source of truth: poll GET /api/state every 2s, and refetch immediately on focus / reconnect.
 * No realtime channel exists on the backend today; if one is added, call `refetch()` from its event (a nudge, not data).
 * serverOffset = serverNow - local time, measured at the midpoint of the request (smoothed).
 */
export function useGameState(opts: { asPlayer: boolean }) {
  const [state, setState] = useState<UiGameState | null>(null);
  const [serverOffset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const offsetSamples = useRef<number[]>([]);
  const lastVersion = useRef<string>("");

  const refetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const sent = Date.now();
    try {
      const s = await getState(opts.asPlayer);
      const got = Date.now();
      // Ignore samples from very slow round trips; keep the median of the last few.
      if (got - sent < 1500) {
        const sample = s.serverNow - (sent + got) / 2;
        offsetSamples.current = [...offsetSamples.current.slice(-4), sample];
        const sorted = [...offsetSamples.current].sort((a, b) => a - b);
        setOffset(sorted[Math.floor(sorted.length / 2)]);
      }
      // Avoid re-rendering the whole tree when nothing changed.
      const sig = JSON.stringify({ ...s, serverNow: 0 });
      if (sig !== lastVersion.current) { lastVersion.current = sig; setState(s); }
      setError(null);
    } catch (e) {
      setError(friendly(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [opts.asPlayer]);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, POLL_MS);
    const nudge = () => { if (document.visibilityState === "visible") refetch(); };
    window.addEventListener("online", nudge);
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", nudge);
    // Mock mode: other tabs write the shared store; refetch as soon as they do.
    const onStorage = (e: StorageEvent) => { if (e.key?.startsWith("aic:mock")) refetch(); };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", nudge);
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", nudge);
      window.removeEventListener("storage", onStorage);
    };
  }, [refetch]);

  return { state, serverOffset, loading, error, refetch };
}
