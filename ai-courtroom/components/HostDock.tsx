"use client";
// Host controls as a fixed overlay. NEVER affects courtroom layout (position: fixed, own stacking context).
// Rendered only after admin unlock; the secret lives in sessionStorage (never the URL).
import { useEffect, useRef, useState } from "react";
import { admin, friendly, USE_MOCK } from "@/lib/api";
import type { UiGameState } from "@/lib/types";
import { MockSwitcher } from "./MockSwitcher";
import { PHASE_LABEL } from "./sides";

type Toast = { id: number; text: string; kind: "ok" | "err" };
type Action = "start" | "advance" | "ai" | "cancel";

export function HostDock({ state, secret, onLock, refetch, idle, onSkipVerdict }: {
  state: UiGameState | null; secret: string; onLock: () => void; refetch: () => Promise<void>; idle: boolean;
  /** Only passed while the projector shows the verdict screen. Client-side only, no API call. */
  onSkipVerdict?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const toast = (text: string, kind: Toast["kind"]) => {
    const id = ++nextId.current;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 6000 : 3000);
  };

  const run = async (a: Action, fn: () => Promise<{ detail?: string }>) => {
    if (busy) return; // one request at a time: Run AI is slow and must not double-fire
    setBusy(a);
    try { const r = await fn(); toast(r.detail ?? "Done", "ok"); await refetch(); }
    catch (e) { toast(friendly(e), "err"); }
    finally { setBusy(null); }
  };

  const r = state?.round ?? null;
  const canAdvance = !!r && r.phase !== "lobby";
  useEffect(() => { if (!open) setConfirmCancel(false); }, [open]);

  const hidden = idle && !open && !busy;
  return (
    <div className={`fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 transition-opacity duration-500 ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`}>
      {toasts.map((t) => (
        <div key={t.id} role="status" className={`animate-slide-up max-w-72 rounded-lg px-3 py-1.5 text-xs font-black shadow ${t.kind === "ok" ? "bg-win text-white" : "bg-agent-a text-white"}`}>{t.text}</div>
      ))}

      {open && (
        <div className="card w-80 animate-pop p-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-black uppercase tracking-widest text-court">Host controls</p>
            <button type="button" onClick={onLock} className="text-xs font-bold text-ink/60 underline">Lock</button>
          </div>
          <p className="mt-1 rounded-md bg-court/10 px-2 py-1 font-mono text-[11px] font-bold leading-snug">
            {r ? <>R{r.number} · {PHASE_LABEL[r.phase]} ({r.rawPhase}) · AI {r.aiStatus}<br />turns {r.turnsCompleted}/{r.maxTurns} · players {state?.playerCount ?? 0}
              {r.betTotals && <> · bets A {r.betTotals.A.players}/{r.betTotals.A.tokens}🪙 B {r.betTotals.B.players}/{r.betTotals.B.tokens}🪙</>}</>
              : <>No round · players {state?.playerCount ?? 0}</>}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <DockBtn label="Start round" busy={busy === "start"} disabled={!!busy} onClick={() => run("start", () => admin.start(secret))} className="bg-win" />
            <DockBtn label="Advance phase" busy={busy === "advance"} disabled={!!busy || !canAdvance} onClick={() => run("advance", () => admin.advance(secret, r!.rawPhase))} className="bg-court" />
            <DockBtn label="Run AI step" busy={busy === "ai"} disabled={!!busy || !r} onClick={() => run("ai", () => admin.runAi(secret, r!.id, r!.rawPhase))} className="bg-agent-b" />
            {!confirmCancel ? (
              <DockBtn label="Cancel + refund" busy={busy === "cancel"} disabled={!!busy || !r || r.phase === "cancelled"} onClick={() => setConfirmCancel(true)} className="bg-agent-a" />
            ) : (
              <div className="grid grid-cols-2 gap-1">
                <DockBtn label="Confirm" busy={busy === "cancel"} disabled={!!busy} onClick={() => { setConfirmCancel(false); run("cancel", () => admin.cancel(secret, r!.id)); }} className="bg-agent-a" />
                <DockBtn label="Back" busy={false} disabled={!!busy} onClick={() => setConfirmCancel(false)} className="bg-ink/60" />
              </div>
            )}
          </div>
          {onSkipVerdict && (
            <button type="button" onClick={onSkipVerdict} className="btn-chunky mt-2 w-full bg-gold py-2 text-xs text-ink !shadow-[0_3px_0_rgba(0,0,0,0.3)]">
              Skip to leaderboard ⏭
            </button>
          )}
          {USE_MOCK && <div className="mt-3 border-t pt-2"><MockSwitcher onChange={refetch} /></div>}
          <p className="mt-2 text-[10px] font-bold text-ink/50">H: hide dock · auto-hides when idle</p>
        </div>
      )}

      <button type="button" onClick={() => setOpen(!open)} aria-label="Host controls" aria-expanded={open}
        className={`grid h-11 w-11 place-items-center rounded-full bg-black/40 text-xl text-white shadow hover:bg-black/60 ${busy ? "animate-spin" : ""}`}>
        ⚙️
      </button>
    </div>
  );
}

function DockBtn({ label, busy, disabled, onClick, className }: { label: string; busy: boolean; disabled: boolean; onClick: () => void; className: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`btn-chunky w-full px-2 py-2 text-xs text-white !shadow-[0_3px_0_rgba(0,0,0,0.3)] ${className}`}>
      {busy ? "Working…" : label}
    </button>
  );
}

/** Small modal to enter the admin secret. */
export function UnlockDialog({ onUnlock, onClose }: { onUnlock: (s: string) => void; onClose: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50" onClick={onClose}>
      <form className="card w-80 p-4" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (v.trim()) onUnlock(v.trim()); }}>
        <p className="font-black">🔐 Host unlock</p>
        <p className="text-xs font-bold text-ink/60">{USE_MOCK ? "Mock mode: any value works." : "Enter ADMIN_SECRET. Stored in this tab only."}</p>
        <input type="password" autoFocus value={v} onChange={(e) => setV(e.target.value)} className="mt-2 w-full rounded-lg border-2 px-2 py-1 font-bold" aria-label="Admin secret" />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1 font-bold">Cancel</button>
          <button type="submit" className="btn-chunky bg-court px-3 py-1 text-white">Unlock</button>
        </div>
      </form>
    </div>
  );
}
