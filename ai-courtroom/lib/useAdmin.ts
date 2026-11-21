"use client";
import { useCallback, useEffect, useState } from "react";

// Admin secret lives in sessionStorage ONLY (never the URL: the projector URL is visible to the audience).
const KEY = "aic:admin-secret";
export function useAdmin() {
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => { setSecret(sessionStorage.getItem(KEY)); }, []);
  const unlock = useCallback((s: string) => { sessionStorage.setItem(KEY, s); setSecret(s); }, []);
  const lock = useCallback(() => { sessionStorage.removeItem(KEY); setSecret(null); }, []);
  return { secret, unlocked: !!secret, unlock, lock };
}
