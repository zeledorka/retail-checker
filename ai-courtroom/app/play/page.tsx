"use client";
import { useState } from "react";
import { join, placeBet, sendSuggestion, USE_MOCK, friendly } from "@/lib/api";
import { useGameState } from "@/lib/useGameState";
import { usePlayer } from "@/lib/usePlayer";
import { useCountdown } from "@/lib/useCountdown";
import type { Side, UiGameState } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { PhaseBadge, PhaseBanner } from "@/components/PhaseBadge";
import { TokenBadge, Delta } from "@/components/TokenBadge";
import { CaseCard } from "@/components/CaseCard";
import { PositionsPanel } from "@/components/PositionsPanel";
import { BetPanel } from "@/components/BetPanel";
import { Transcript } from "@/components/Transcript";
import { SuggestionBox } from "@/components/SuggestionBox";
import { VerdictPanel } from "@/components/VerdictPanel";
import { Podium, rankOf } from "@/components/Leaderboard";
import { AgentIcon, SIDE } from "@/components/sides";
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
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col">
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

  const onBet = async (side: Side, stake: number) => { await placeBet(r!.id, side, stake); await refetch(); };
  const onSend = async (text: string) => { await sendSuggestion(r!.id, r!.rawPhase, text); await refetch(); };

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-court-dark/90 px-3 py-2 backdrop-blur">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black">{me.nickname}</p>
          <PhaseBadge phase={state.phase} className="mt-0.5 !text-[11px]" />
        </div>
        <TokenBadge tokens={me.tokens} />
        <Countdown deadline={r?.phaseEndsAt} start={r?.phaseStartedAt} offset={offset} size={48} />
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
            {state.phase === "openings" && !me.suggestion
              ? <div className="rounded-2xl bg-white/15 p-4 text-center font-bold">💡 Suggestions open once the openings are done.</div>
              : <SuggestionBox betSide={me.bet?.side ?? null} open={r.suggestionsOpen && !expired} sent={me.suggestion} onSend={onSend} />}
          </>
        )}

        {state.phase === "judging" && (
          <>
            <Waiting title="The judge is deliberating" text="Weighing evidence, logic, rebuttal and persuasion…" emoji="👨‍⚖️" />
            <MyBetStrip state={state} />
          </>
        )}

        {state.phase === "results" && <Results state={state} />}

        {state.phase === "cancelled" && (
          <div className="grid gap-4 text-center">
            <PhaseBanner phase="cancelled" />
            <div className="card p-5 text-lg font-black">
              {me.bet ? <>💸 Your {me.bet.stake} tokens were refunded.</> : <>No tokens were lost. Hang tight for the next round.</>}
            </div>
            <p className="font-bold text-white/80">Waiting for the next round…</p>
          </div>
        )}
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

function Results({ state }: { state: UiGameState }) {
  const me = state.me!;
  const v = state.verdict;
  const rank = rankOf(state.leaderboard);
  if (!v) return <Waiting title="Settling the bets" text="Counting the tokens…" emoji="🪙" />;
  const won = me.bet ? me.bet.side === v.winner : null;
  return (
    <div className="grid gap-4">
      <div className={`animate-pop rounded-3xl p-6 text-center shadow-[0_8px_0_rgba(0,0,0,0.3)] ${won === null ? "bg-white/15" : won ? "bg-win" : "bg-agent-a"}`}>
        <p className="text-5xl font-black drop-shadow-[0_4px_0_rgba(0,0,0,0.25)]">{won === null ? "Verdict is in" : won ? "YOU WIN! 🎉" : "YOU LOSE 😵"}</p>
        {me.roundDelta !== null && <div className="mt-3"><Delta value={me.roundDelta} className="text-3xl" /></div>}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-3 font-black">
          <span>Balance</span><TokenBadge tokens={me.tokens} />
          {rank && <span className="rounded-full bg-white/20 px-3 py-1">#{rank} of {state.leaderboard.length}</span>}
        </div>
        {won === null && <p className="mt-2 font-bold">You didn&apos;t bet this round.</p>}
      </div>
      <VerdictPanel v={v} />
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
