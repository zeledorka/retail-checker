"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getState, friendly } from "@/lib/api";
import type { UiGameState } from "@/lib/types";

/** Normal poll: every 2.5s plus up to 0.5s of random jitter (so hundreds of phones don't hit the server in lockstep). */
const POLL_BASE_MS = 2500;
const POLL_JITTER_MS = 500;
/** After consecutive failures: 2.5s, 5s, 10s, 10s... (+ jitter). Reset on the first success. */
const BACKOFF_CAP_MS = 10_000;

/**
 * Server is the source of truth: poll GET /api/state, refetch immediately on focus / reconnect / tab becoming visible.
 * - One request at a time (a tick is skipped while one is in flight).
 * - Polling pauses while the tab is hidden and resumes with an immediate fetch when it's visible again.
 * - Exponential backoff on consecutive errors; the last good state keeps rendering meanwhile (`error` is set).
 * - No realtime channel exists on the backend; if one is added, call `refetch()` from its event (a nudge, not data).
 * serverOffset = serverNow - local time, measured at the midpoint of the request (median of the last few samples).
 * Time and `document` are only read in effects/callbacks, never during render.
 */
export function useGameState(opts: { asPlayer: boolean }) {
  const [state, setState] = useState<UiGameState | null>(null);
  const [serverOffset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const offsetSamples = useRef<number[]>([]);
  const lastSig = useRef<string>("");

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const fetchOnce = useCallback(async () => {
    if (inFlight.current) return; // never overlap requests
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
      if (sig !== lastSig.current) { lastSig.current = sig; setState(s); }
      failures.current = 0;
      setError(null);
    } catch (e) {
      failures.current += 1;
      setError(friendly(e)); // the last good `state` is kept
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [opts.asPlayer]);

  /** Fetch now, then schedule the next poll (unless the tab is hidden: polling pauses until it's visible). */
  const run = useCallback(async (): Promise<void> => {
    // A request is already running (e.g. a refetch right after a bet during a poll): don't overlap, but queue ONE
    // follow-up so the newest server state is fetched as soon as the current request finishes.
    if (inFlight.current) { again.current = true; return; }
    clearTimer();
    await fetchOnce();
    if (again.current) { again.current = false; return run(); }
    if (!alive.current || document.hidden) return;
    clearTimer();
    const f = failures.current;
    const base = f === 0 ? POLL_BASE_MS : Math.min(BACKOFF_CAP_MS, POLL_BASE_MS * 2 ** (f - 1));
    timer.current = setTimeout(run, base + Math.random() * POLL_JITTER_MS);
  }, [fetchOnce]);

  useEffect(() => {
    alive.current = true;
    run();
    const onVisible = () => { if (document.hidden) clearTimer(); else run(); };
    const nudge = () => { if (!document.hidden) run(); };
    // Mock mode: other tabs write the shared store; refetch as soon as they do.
    const onStorage = (e: StorageEvent) => { if (e.key?.startsWith("aic:mock")) nudge(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", nudge);
    window.addEventListener("focus", nudge);
    window.addEventListener("storage", onStorage);
    return () => {
      alive.current = false;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", nudge);
      window.removeEventListener("focus", nudge);
      window.removeEventListener("storage", onStorage);
    };
  }, [run]);

  /** Manual refresh (after an action, retry button, realtime nudge): fetches now and resets the poll timer. */
  const refetch = useCallback(async () => { await run(); }, [run]);

  return { state, serverOffset, loading, error, refetch };
}
