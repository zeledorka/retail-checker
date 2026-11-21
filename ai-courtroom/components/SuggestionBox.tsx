"use client";
import { useState } from "react";
import { friendly } from "@/lib/api";
import type { Side } from "@/lib/types";
import { AgentIcon, SIDE } from "./sides";

const MAX = 200; // server rule (/api/inject: 1-200 chars) and the AI module's cut-off

type Props = {
  betSide: Side | null;
  open: boolean;
  sent: { side: Side; text: string } | null;
  onSend: (text: string) => Promise<void>;
};

/** One suggestion per player per round, routed to the side they bet on. */
export function SuggestionBox({ betSide, open, sent, onSend }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <div className={`animate-pop rounded-2xl p-4 text-white shadow-[0_5px_0_rgba(0,0,0,0.25)] ${SIDE[sent.side].bg}`}>
        <p className="flex items-center gap-2 font-black"><AgentIcon side={sent.side} className="w-5 h-5" /> Sent to {SIDE[sent.side].name}! ✅</p>
        <p className="mt-1 text-sm font-bold text-white/90">&ldquo;{sent.text}&rdquo;</p>
      </div>
    );
  }
  if (!betSide) {
    return <div className="rounded-2xl bg-white/15 p-4 text-center font-bold">💡 Only players who placed a bet can coach an agent this round.</div>;
  }
  if (!open) {
    return <div className="rounded-2xl bg-white/15 p-4 text-center font-bold">💡 The suggestion window is closed.</div>;
  }

  const trimmed = text.trim();
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true); setError(null);
    try { await onSend(trimmed); } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };

  return (
    <div className="card p-4">
      <label htmlFor="tip" className="flex items-center gap-2 font-black">
        💡 Your suggestion goes to
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-white ${SIDE[betSide].bg}`}>
          <AgentIcon side={betSide} className="w-3.5 h-3.5" /> {SIDE[betSide].name}
        </span>
      </label>
      <textarea id="tip" value={text} onChange={(e) => setText(e.target.value.slice(0, MAX))} maxLength={MAX} disabled={busy} rows={3}
        placeholder="e.g. Point out that the room was locked overnight!"
        className="mt-2 w-full resize-none rounded-xl border-4 border-court/20 p-3 font-bold outline-none focus:border-court" />
      <div className="mt-1 flex items-center justify-between text-sm font-bold text-ink/60">
        <span>One shot per round. Make it count.</span>
        <span className={text.length >= MAX ? "text-agent-a" : ""}>{text.length}/{MAX}</span>
      </div>
      {error && <p role="alert" className="animate-shake mt-2 rounded-xl bg-red-100 p-2 text-center font-black text-agent-a">{error}</p>}
      <button type="button" onClick={submit} disabled={!trimmed || busy} className={`btn-chunky mt-3 w-full py-3 text-xl text-white ${SIDE[betSide].bg}`}>
        {busy ? "Sending…" : `Send to ${SIDE[betSide].name}`}
      </button>
    </div>
  );
}
