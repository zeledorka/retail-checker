"use client";
// Host controls as a fixed overlay. NEVER affects courtroom layout (position: fixed, own stacking context).
// Rendered only after admin unlock; the secret lives in sessionStorage (never the URL).
import { useEffect, useRef, useState } from "react";
import { admin, friendly, USE_MOCK } from "@/lib/api";
import type { AdminResult, UiGameState } from "@/lib/types";
import { MockSwitcher } from "./MockSwitcher";
import { PHASE_LABEL } from "./sides";

type Toast = { id: number; text: string; kind: "ok" | "info" | "err" };
type Action = "start" | "advance" | "ai" | "cancel" | "tick" | "reset";
/** Autopilot interval: the backend expects /api/admin/tick about once a second. */
const AUTOPILOT_MS = 1000;

export function HostDock({ state, secret, onLock, refetch, idle, onSkipVerdict, forceHidden = false }: {
  state: UiGameState | null; secret: string; onLock: () => void; refetch: () => Promise<void>; idle: boolean;
  /** H key: fully hidden but still MOUNTED, so a running autopilot keeps going. */
  forceHidden?: boolean;
  /** Only passed while the projector shows the verdict screen. Client-side only, no API call. */
  onSkipVerdict?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  const busyRef = useRef<Action | null>(null);
  busyRef.current = busy;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const toast = (text: string, kind: Toast["kind"]) => {
    const id = ++nextId.current;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 6000 : 3000);
  };

  const run = async (a: Action, fn: () => Promise<AdminResult>) => {
    if (busy) return; // one request at a time: Run AI is slow and must not double-fire
    setBusy(a);
    try { const r = await fn(); toast(r.detail ?? "Done", r.kind === "error" ? "err" : r.kind ?? "ok"); await refetch(); }
    catch (e) { toast(friendly(e), "err"); }
    finally { setBusy(null); }
  };

  const r = state?.round ?? null;
  const canAdvance = !!r && r.phase !== "lobby";
  useEffect(() => { if (!open) { setConfirmCancel(false); setConfirmReset(false); } }, [open]);

  // Autopilot: call /api/admin/tick about once a second, one call at a time (each call does at most ONE thing:
  // an AI call, a phase change when time is up / AI work is done, or nothing). Pauses while a manual action runs.
  // Only changes and errors are toasted, not every quiet tick. Stops itself after 3 consecutive errors.
  useEffect(() => {
    if (!autopilot) return;
    let stopped = false;
    let errors = 0;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (stopped) return;
      if (!busyRef.current) {
        try {
          const r = await admin.tick(secret);
          errors = 0;
          if (r.kind === "error") toast(r.detail ?? "Tick failed", "err");
          else if (r.kind !== "info") toast(r.detail ?? "Tick", "ok");
          await refetch();
        } catch (e) {
          errors += 1;
          toast(`Autopilot: ${friendly(e)}`, "err");
          if (errors >= 3) { toast("Autopilot stopped after 3 errors", "err"); setAutopilot(false); return; }
        }
      }
      if (!stopped) timer = setTimeout(loop, AUTOPILOT_MS);
    };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
    // toast/refetch are stable enough for this loop; restarting it on every render would double-tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilot, secret]);

  const hidden = forceHidden || (idle && !open && !busy);
  return (
    <div className={`fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 transition-opacity duration-500 ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`} aria-hidden={forceHidden || undefined}>
      {toasts.map((t) => (
        <div key={t.id} role="status" className={`animate-slide-up max-w-72 rounded-lg px-3 py-1.5 text-xs font-black shadow ${t.kind === "ok" ? "bg-win text-white" : t.kind === "info" ? "bg-white text-ink" : "bg-agent-a text-white"}`}>{t.text}</div>
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
            {autopilot && <><br /><span className="text-win">● Autopilot ON</span></>}
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
          <div className="mt-2 grid grid-cols-2 gap-2">
            <DockBtn label="Tick (1 step)" busy={busy === "tick"} disabled={!!busy} onClick={() => run("tick", () => admin.tick(secret))} className="bg-court-light" />
            <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-black ${autopilot ? "bg-win text-white" : "bg-court/10 text-ink"}`}
              title="Calls /api/admin/tick every second: runs the AI turns and moves to the next phase when its time is up.">
              <input type="checkbox" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} className="accent-court" />
              Autopilot
            </label>
          </div>
          {!confirmReset ? (
            <DockBtn label="Reset game…" busy={busy === "reset"} disabled={!!busy} onClick={() => setConfirmReset(true)} className="mt-2 bg-ink/70" />
          ) : (
            <div className="mt-2 grid grid-cols-[2fr_1fr] gap-1">
              <DockBtn label="Confirm reset (all players back to 100)" busy={busy === "reset"} disabled={!!busy}
                onClick={() => { setConfirmReset(false); setAutopilot(false); run("reset", () => admin.reset(secret)); }} className="bg-agent-a" />
              <DockBtn label="Back" busy={false} disabled={!!busy} onClick={() => setConfirmReset(false)} className="bg-ink/60" />
            </div>
          )}
          {onSkipVerdict && (
            <button type="button" onClick={onSkipVerdict} className="btn-chunky mt-2 w-full bg-gold py-2 text-xs text-ink !shadow-[0_3px_0_rgba(0,0,0,0.3)]">
              Skip to leaderboard ⏭
            </button>
          )}
          {USE_MOCK && <div className="mt-3 border-t pt-2"><MockSwitcher onChange={refetch} /></div>}
          <p className="mt-2 text-[10px] font-bold text-ink/50">H: hide dock (autopilot keeps running) · auto-hides when idle</p>
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
