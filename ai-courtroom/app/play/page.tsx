"use client";
import { useState } from "react";
import { join, placeBet, sendSuggestion, USE_MOCK, friendly } from "@/lib/api";
import { useGameState } from "@/lib/useGameState";
import { usePlayer } from "@/lib/usePlayer";
import { useCountdown } from "@/lib/useCountdown";
import type { Side, UiGameState } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { PhaseBadge, PhaseBanner } from "@/components/PhaseBadge";
import { TokenBadge, Delta, CountUp } from "@/components/TokenBadge";
import { useRoundBaseline } from "@/lib/useRoundBaseline";
import { CaseCard } from "@/components/CaseCard";
import { PositionsPanel } from "@/components/PositionsPanel";
import { BetPanel } from "@/components/BetPanel";
import { Transcript } from "@/components/Transcript";
import { SuggestionBox } from "@/components/SuggestionBox";

import { Podium, rankOf } from "@/components/Leaderboard";
import { AgentIcon, AgentTag, SIDE } from "@/components/sides";
import { MockSwitcher } from "@/components/MockSwitcher";

export default function PlayPage() {
  const { state, serverOffset, loading, error, refetch } = useGameState({ asPlayer: true });
  const player = usePlayer();

  let body: React.ReactNode;
  if (!player.ready || (loading && !state)) body = <Splash />;
  else if (!state) body = <ErrorScreen message={error ?? "Can't load the game"} onRetry={refetch} />;
  else if (!state.me) body = <JoinScreen initial={player.nickname ?? ""} onJoined={async (n) => { player.remember(n); await refetch(); }} />;
  else body = <Game state={state} offset={serverOffset} error={error} refetch={refetch} />;

  return (
    <main className="play-root mx-auto flex w-full max-w-md flex-1 flex-col">
      {body}
      {USE_MOCK && <MockFab onChange={refetch} />}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Logo({ big = false }: { big?: boolean }) {
  return (
    <div className="text-center">
      <div className={`inline-block animate-wiggle ${big ? "text-7xl" : "text-5xl"}`} aria-hidden>⚖️</div>
      <h1 className={`font-black tracking-tight drop-shadow-[0_4px_0_rgba(0,0,0,0.3)] ${big ? "text-5xl" : "text-4xl"}`}>AI Courtroom</h1>
    </div>
  );
}

function Splash() {
  return <div className="grid flex-1 place-items-center p-6"><Logo /></div>;
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-6 text-center">
      <div className="grid gap-4">
        <Logo />
        <p className="card p-4 font-black text-agent-a">📡 {message}</p>
        <button type="button" onClick={onRetry} className="btn-chunky bg-white py-3 text-xl text-court">Try again</button>
      </div>
    </div>
  );
}

function JoinScreen({ initial, onJoined }: { initial: string; onJoined: (nickname: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setError(null);
    try { const r = await join(n); await onJoined(r.nickname); } catch (err) { setError(friendly(err)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="flex flex-1 flex-col justify-center gap-6 p-6">
      <Logo big />
      <p className="text-center text-lg font-bold text-white/80">Bet on the AI lawyer you believe. Whisper them a tip. Hear the verdict.</p>
      <div className="card grid gap-3 p-4">
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 20))} maxLength={20} autoFocus autoComplete="nickname"
          placeholder="Nickname" aria-label="Nickname"
          className="w-full rounded-xl border-4 border-gray-200 px-4 py-4 text-center text-2xl font-black outline-none focus:border-court" />
        <button type="submit" disabled={!name.trim() || busy} className="btn-chunky bg-ink py-4 text-2xl text-white">
          {busy ? "Joining…" : "Join"}
        </button>
        {error && <p role="alert" className="animate-shake text-center font-black text-agent-a">{error}</p>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Game({ state, offset, error, refetch }: { state: UiGameState; offset: number; error: string | null; refetch: () => Promise<void> }) {
  const me = state.me!;
  const r = state.round;
  const { expired } = useCountdown(r?.phaseEndsAt, offset);
  const baseline = useRoundBaseline(state);
  const roundOver = state.phase === "results" || state.phase === "cancelled";

  const onBet = async (side: Side, stake: number) => { await placeBet(r!.id, side, stake); await refetch(); };
  const onSend = async (text: string) => { await sendSuggestion(r!.id, text); await refetch(); };

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-court-dark/90 px-3 py-2 backdrop-blur">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black">{me.nickname}</p>
          <PhaseBadge phase={state.phase} className="mt-0.5 !text-[11px]" />
        </div>
        <TokenBadge tokens={me.tokens} />
        {/* No countdown once the round is over: the next round starts when the host says so. */}
        {!roundOver && <Countdown deadline={r?.phaseEndsAt} start={r?.phaseStartedAt} offset={offset} size={42} />}
      </header>
      {error && <p className="bg-agent-a px-3 py-1 text-center text-sm font-black">📡 Reconnecting… ({error})</p>}

      <section key={state.phase} className="animate-slide-up flex flex-1 flex-col gap-4 p-4">
        {state.phase === "lobby" && <Waiting title="You're in!" text="Waiting for the host to start…" emoji="🧑‍⚖️" />}

        {state.phase === "game_over" && (
          <>
            <PhaseBanner phase="game_over" sub="Thanks for playing!" />
            <Podium entries={state.leaderboard} />
          </>
        )}

        {state.phase === "reveal" && state.case && (
          <>
            <PhaseBanner phase="reveal" sub="Read fast: betting opens soon" />
            <CaseCard c={state.case} />
            <PositionsPanel c={state.case} />
          </>
        )}

        {state.phase === "betting" && state.case && (
          <>
            <PhaseBanner phase="betting" sub={state.case.title} />
            <BetPanel tokens={me.tokens} bet={me.bet} open={!!r?.bettingOpen && !expired}
              positions={{ A: state.case.positionA, B: state.case.positionB }} onBet={onBet} />
          </>
        )}

        {(state.phase === "openings" || state.phase === "debate") && r && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-black">{state.phase === "openings" ? "Opening statements" : "The debate"}</h2>
              <span className="rounded-full bg-white/15 px-3 py-1 text-sm font-black">Turn {Math.max(1, state.transcript.length)} of {r.maxTurns + 2}</span>
            </div>
            <MyBetStrip state={state} />
            <Transcript items={state.transcript} thinking={r.nextSpeaker} className="max-h-[45vh] rounded-2xl bg-black/15 p-3" />
            {/* Clues are accepted during OPENINGS and DEBATE until the phase deadline (server rule), one per round. */}
            <SuggestionBox betSide={me.bet?.side ?? null} open={r.suggestionsOpen && !expired} sent={me.suggestion} onSend={onSend} />
          </>
        )}

        {state.phase === "judging" && (
          <>
            <Waiting title="The judge is deliberating" text="Weighing evidence, logic, rebuttal and persuasion…" emoji="👨‍⚖️" />
            <MyBetStrip state={state} />
          </>
        )}

        {/* Stays up until the SERVER moves to a new round / lobby: no local timer returns to betting. */}
        {(state.phase === "results" || state.phase === "cancelled") && <RoundOver state={state} baseline={baseline} />}
      </section>
    </>
  );
}

function MyBetStrip({ state }: { state: UiGameState }) {
  const bet = state.me?.bet;
  if (!bet) return <p className="rounded-xl bg-white/10 px-3 py-2 text-center text-sm font-bold">👀 You&apos;re spectating this round (no bet).</p>;
  return (
    <p className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-black text-white ${SIDE[bet.side].bg}`}>
      <AgentIcon side={bet.side} className="w-4 h-4" /> You bet {bet.stake} on {SIDE[bet.side].name}
    </p>
  );
}

function Waiting({ title, text, emoji }: { title: string; text: string; emoji: string }) {
  return (
    <div className="grid flex-1 place-items-center text-center">
      <div>
        <div className="animate-float text-8xl" aria-hidden>{emoji}</div>
        <h2 className="mt-4 text-3xl font-black">{title}</h2>
        <p className="mt-2 text-lg font-bold text-white/80">{text}</p>
        <div className="mt-6 flex justify-center gap-2" aria-hidden>
          {[0, 1, 2].map((i) => <span key={i} className="h-4 w-4 animate-bounce rounded-full bg-white" style={{ animationDelay: `${i * 150}ms` }} />)}
        </div>
      </div>
    </div>
  );
}

/** End of round (results or cancelled): outcome, token summary, waiting bar, compact verdict. */
function RoundOver({ state, baseline }: { state: UiGameState; baseline: number | null }) {
  const me = state.me!;
  const v = state.verdict;
  const cancelled = state.phase === "cancelled";
  if (!cancelled && !v) return <Waiting title="Settling the bets" text="Counting the tokens…" emoji="🪙" />;

  const bet = me.bet;
  const won = !cancelled && bet && v ? bet.side === v.winner : null;
  const outcome = cancelled ? (bet ? "refunded" : "cancelled") : !bet ? "nobet" : won ? "win" : "lose";
  const HEAD = {
    win: { text: "YOU WIN! 🎉", sub: `Agent ${v?.winner} took the case`, bg: "bg-win" },
    lose: { text: "YOU LOSE 😵", sub: `Agent ${v?.winner} took the case`, bg: "bg-agent-a" },
    refunded: { text: "REFUNDED 💸", sub: "The round was cancelled", bg: "bg-gold text-ink" },
    cancelled: { text: "Round cancelled", sub: "No bet placed, nothing lost", bg: "bg-white/15" },
    nobet: { text: "No bet placed", sub: "You watched this one from the gallery", bg: "bg-white/15" },
  }[outcome];

  // Token summary from SERVER data only: server delta/before if exposed, else (balance now - balance seen before the round).
  const before = me.tokensBefore ?? baseline;
  const delta = me.roundDelta ?? (before !== null ? me.tokens - before : bet ? null : 0);
  const rank = rankOf(state.leaderboard);

  return (
    <div className="grid gap-4">
      <div className={`animate-pop rounded-3xl p-5 text-center shadow-[0_8px_0_rgba(0,0,0,0.3)] ${HEAD.bg}`}>
        <p className="text-5xl font-black drop-shadow-[0_4px_0_rgba(0,0,0,0.2)]">{HEAD.text}</p>
        <p className="mt-1 text-lg font-bold opacity-90">{HEAD.sub}</p>
      </div>

      <div className="card animate-slide-up p-5 text-center" style={{ animationDelay: "150ms" }}>
        <p className="text-sm font-black uppercase tracking-widest text-court">Your tokens</p>
        <p className="mt-1 flex items-center justify-center gap-2 text-7xl font-black leading-none">
          <span className="text-5xl" aria-hidden>🪙</span>
          <CountUp from={before ?? me.tokens} to={me.tokens} />
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 font-black">
          {outcome === "refunded" ? <span className="animate-pop rounded-full bg-gold px-3 py-1 text-2xl text-ink">Refunded</span>
            : delta !== null && <Delta value={delta} className="text-2xl" />}
          {before !== null && before !== me.tokens && <span className="text-lg text-ink/60">{before} → {me.tokens}</span>}
          {rank && <span className="rounded-full bg-court/10 px-3 py-1 text-lg">#{rank} of {state.leaderboard.length}</span>}
        </div>
        {me.tokens === 0 && <p className="mt-2 font-bold text-agent-a">Out of tokens! You can still watch and cheer.</p>}
      </div>

      <div className="animate-slide-up grid gap-2" style={{ animationDelay: "300ms" }} role="status">
        <div className="waiting-bar" aria-hidden />
        <p className="text-center font-black">Waiting for the host to start a new round...</p>
      </div>

      {v && (
        <div className="card animate-slide-up p-4" style={{ animationDelay: "450ms" }}>
          <div className="flex items-center gap-2 font-black">⚖️ Winner: <AgentTag side={v.winner} /></div>
          {!v.complete && <p className="mt-2 text-sm font-black text-gold-dark">⏱️ Judged on {v.turnsCompleted} of {v.maxTurns} debate turns (cut short).</p>}
          <p className="mt-2 font-bold">{v.summary ?? v.explanation}</p>
          {v.summary && (
            <details className="mt-2 text-sm font-semibold">
              <summary className="cursor-pointer font-black text-court">Judge&apos;s full reasoning</summary>
              <p className="mt-1">{v.explanation}</p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function MockFab({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fixed bottom-3 right-3 z-50 flex flex-col items-end gap-2">
      {open && <div className="card w-72 p-3"><MockSwitcher onChange={onChange} compact /></div>}
      <button type="button" onClick={() => setOpen(!open)} aria-label="Mock controls" className="h-10 w-10 rounded-full bg-black/40 text-lg opacity-60 hover:opacity-100">🧪</button>
    </div>
  );
}
