"use client";
import { useEffect, useState } from "react";

/**
 * Countdown to a SERVER deadline. serverNow ~= Date.now() + offset, so remaining = deadline - (Date.now() + offset).
 * Never starts a local timer from a click: it only ever reads the server's timestamps.
 */
export function useCountdown(deadline: number | null | undefined, offset: number, start?: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return { msLeft: null, seconds: null, fraction: null, expired: false };
  const msLeft = Math.max(0, deadline - (now + offset));
  const total = start ? Math.max(1, deadline - start) : null;
  return {
    msLeft,
    seconds: Math.ceil(msLeft / 1000),
    /** 1 -> 0 over the phase, when the start is known. */
    fraction: total ? Math.min(1, msLeft / total) : null,
    expired: msLeft <= 0,
  };
}
