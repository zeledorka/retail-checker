"use client";
import { useState } from "react";
import { friendly } from "@/lib/api";
import type { Side, UiBet } from "@/lib/types";
import { AgentIcon, SIDE } from "./sides";

type Props = {
  tokens: number;
  bet: UiBet | null;
  open: boolean;
  positions: Record<Side, string>;
  onBet: (side: Side, stake: number) => Promise<void>;
};

const CHIPS = [10, 25, 50];

export function BetPanel({ tokens, bet, open, positions, onBet }: Props) {
  const [side, setSide] = useState<Side | null>(null);
  const [stake, setStake] = useState(() => Math.min(25, tokens));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (bet) {
    return (
      <div className={`animate-pop rounded-3xl p-6 text-center text-white shadow-[0_6px_0_rgba(0,0,0,0.25)] ${SIDE[bet.side].bg}`}>
        <p className="text-sm font-black uppercase tracking-widest text-white/80">🔒 Bet locked in</p>
        <div className="mt-2 flex items-center justify-center gap-2 text-3xl font-black">
          <AgentIcon side={bet.side} className="w-8 h-8" /> {bet.stake} on {SIDE[bet.side].name}
        </div>
        <p className="mt-2 font-bold text-white/90">Win and you get {bet.stake * 2} back.</p>
      </div>
    );
  }
  if (!open) {
    return <div className="card p-5 text-center text-lg font-black">⏰ Betting is closed for this round. Sit back and watch!</div>;
  }
  if (tokens <= 0) {
    return <div className="card p-5 text-center text-lg font-black">😬 You&apos;re out of tokens. Watch this round and cheer!</div>;
  }

  const valid = side !== null && Number.isInteger(stake) && stake >= 1 && stake <= tokens;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try { await onBet(side!, stake); } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        {(["A", "B"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)} disabled={busy} aria-pressed={side === s}
            className={`btn-chunky flex min-h-24 items-center gap-3 p-4 text-left text-white ${SIDE[s].bg} ${side === s ? "ring-4 ring-white scale-[1.02]" : side ? "opacity-60" : ""}`}>
            <AgentIcon side={s} className="w-10 h-10 shrink-0" />
            <span>
              <span className="block text-xl font-black">{SIDE[s].name}</span>
              <span className="block text-sm font-bold leading-snug text-white/90">{positions[s]}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between font-black">
          <label htmlFor="stake">Wager</label>
          <span className="text-2xl">🪙 {stake}</span>
        </div>
        <input id="stake" type="range" min={1} max={tokens} value={Math.min(stake, tokens)} onChange={(e) => setStake(Number(e.target.value))}
          className="mt-2 w-full accent-[#46178f]" disabled={busy} />
        <div className="mt-3 grid grid-cols-4 gap-2">
          {CHIPS.map((c) => (
            <button key={c} type="button" disabled={busy || c > tokens} onClick={() => setStake(c)}
              className={`btn-chunky py-2 text-white ${stake === c ? "bg-court-dark" : "bg-court"}`}>{c}</button>
          ))}
          <button type="button" disabled={busy} onClick={() => setStake(tokens)} className={`btn-chunky py-2 text-ink ${stake === tokens ? "bg-gold-dark" : "bg-gold"}`}>All-in</button>
        </div>
      </div>

      {error && <p role="alert" className="animate-shake rounded-xl bg-white p-3 text-center font-black text-agent-a">{error}</p>}

      <button type="button" onClick={submit} disabled={!valid || busy}
        className="btn-chunky bg-win py-4 text-2xl text-white">
        {busy ? "Placing bet…" : side ? `Bet ${stake} on ${SIDE[side].name}` : "Pick an agent"}
      </button>
    </div>
  );
}
