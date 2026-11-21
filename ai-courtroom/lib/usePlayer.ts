"use client";
import { useCallback, useEffect, useState } from "react";
import { clearPlayer, readPlayer, writePlayer } from "@/lib/identity";

/**
 * Player identity restored from localStorage on refresh. `ready` is false until the browser has been read
 * (avoids hydration mismatch). Whether the server knows the player is decided by state.me (server truth).
 */
export function usePlayer() {
  const [ready, setReady] = useState(false);
  const [nickname, setNick] = useState<string | null>(null);
  useEffect(() => {
    setNick(readPlayer().nickname ?? null);
    setReady(true);
  }, []);
  const remember = useCallback((n: string) => {
    writePlayer({ ...readPlayer(), nickname: n });
    setNick(n);
  }, []);
  const forget = useCallback(() => { clearPlayer(); setNick(null); }, []);
  return { ready, nickname, remember, forget };
}
