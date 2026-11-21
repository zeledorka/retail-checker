"use client";
// Projector: read-only 16:9 courtroom. Host dock is a fixed overlay rendered only after admin unlock
// (press U, or click the bottom-right corner). ?view=display never shows the dock.
import { useEffect, useState } from "react";
import { useGameState } from "@/lib/useGameState";
import { useAdmin } from "@/lib/useAdmin";
import type { PublicArgument, Side, UiGameState } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { PhaseBanner } from "@/components/PhaseBadge";
import { CaseCard } from "@/components/CaseCard";
import { PositionCard, PositionsPanel } from "@/components/PositionsPanel";
import { SpeechBubble, ThinkingBubble } from "@/components/SpeechBubble";
import { IncompleteNotice, ScoreBars, WinnerReveal } from "@/components/VerdictPanel";
import { Podium } from "@/components/Leaderboard";
import { AgentIcon, SIDE } from "@/components/sides";
import { HostDock, UnlockDialog } from "@/components/HostDock";

const IDLE_MS = 3000;

export default function ProjectorPage() {
  const { state, serverOffset, error, refetch } = useGameState({ asPlayer: false });
  const adm = useAdmin();
  const [displayOnly, setDisplayOnly] = useState(true); // safe default until the URL is read
  const [joinUrl, setJoinUrl] = useState("");
  const [idle, setIdle] = useState(false);
  const [dockHidden, setDockHidden] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    setDisplayOnly(new URLSearchParams(window.location.search).get("view") === "display");
    setJoinUrl(`${window.location.host}/play`);
  }, []);

  // Idle: fade the dock and hide the cursor; any mouse movement brings both back.
  useEffect(() => {
    let t = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), IDLE_MS); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "h" || e.key === "H") setDockHidden((v) => !v);
      if (e.key === "u" || e.key === "U") setUnlocking(true);
      wake();
    };
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("mousemove", wake); window.removeEventListener("keydown", onKey); };
  }, []);

  const canDock = !displayOnly;
  return (
    <main className={`fixed inset-0 overflow-hidden ${idle ? "cursor-none" : ""}`}>
      <Courtroom state={state} offset={serverOffset} joinUrl={joinUrl} />
      {error && <p className="fixed left-1/2 top-2 -translate-x-1/2 rounded-full bg-agent-a px-4 py-1 text-sm font-black">📡 Reconnecting…</p>}

      {canDock && adm.secret && !dockHidden && (
        <HostDock state={state} secret={adm.secret} onLock={adm.lock} refetch={refetch} idle={idle} />
      )}
      {canDock && !adm.secret && (
        // Invisible hotspot so the host can unlock without a keyboard shortcut. Nothing visible to the audience.
        <button type="button" aria-label="Host unlock" onClick={() => setUnlocking(true)} className="fixed bottom-0 right-0 z-50 h-8 w-8 opacity-0" />
      )}
      {canDock && unlocking && !adm.secret && (
        <UnlockDialog onClose={() => setUnlocking(false)} onUnlock={(s) => { adm.unlock(s); setUnlocking(false); }} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Courtroom({ state, offset, joinUrl }: { state: UiGameState | null; offset: number; joinUrl: string }) {
  if (!state) {
    return <div className="grid h-full place-items-center"><Title /></div>;
  }
  const r = state.round;
  return (
    <div className="flex h-full flex-col p-8">
      <header className="flex h-24 shrink-0 items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-5xl" aria-hidden>⚖️</span>
          <div>
            <p className="text-3xl font-black leading-none">AI Courtroom</p>
            {r && <p className="text-lg font-bold text-white/70">Round {r.number}{state.game.maxRounds ? ` of ${state.game.maxRounds}` : ""} · join at {joinUrl}</p>}
          </div>
        </div>
        {state.phase !== "lobby" && <PhaseBanner phase={state.phase} className="!text-left" />}
        <div className="w-28">
          <Countdown deadline={r?.phaseEndsAt} start={r?.phaseStartedAt} offset={offset} size={112} />
        </div>
      </header>

      <section key={state.phase} className="mt-6 min-h-0 flex-1">
        <Stage state={state} joinUrl={joinUrl} />
      </section>
    </div>
  );
}

function Title() {
  return (
    <div className="text-center">
      <div className="animate-wiggle inline-block text-[10rem] leading-none" aria-hidden>⚖️</div>
      <h1 className="text-9xl font-black drop-shadow-[0_8px_0_rgba(0,0,0,0.3)]">AI Courtroom</h1>
    </div>
  );
}

function Stage({ state, joinUrl }: { state: UiGameState; joinUrl: string }) {
  const r = state.round;
  const c = state.case;
  switch (state.phase) {
    case "lobby":
      return (
        <div className="grid h-full grid-rows-[auto_1fr] gap-6">
          <div className="text-center">
            <Title />
            <p className="mt-6 inline-block rounded-3xl bg-white px-10 py-4 text-6xl font-black text-court shadow-[0_8px_0_rgba(0,0,0,0.3)]">Join at {joinUrl}</p>
            <p className="mt-4 text-4xl font-black">👥 {state.playerCount} player{state.playerCount === 1 ? "" : "s"}</p>
          </div>
          <div className="flex flex-wrap content-start justify-center gap-3 overflow-hidden">
            {state.leaderboard.map((p, i) => (
              <span key={p.nickname + i} className="animate-pop rounded-xl bg-white/15 px-5 py-2 text-3xl font-black" style={{ animationDelay: `${i * 60}ms` }}>{p.nickname}</span>
            ))}
          </div>
        </div>
      );
    case "game_over":
      return <div className="mx-auto h-full max-w-5xl"><Podium entries={state.leaderboard} big maxRest={4} /></div>;
    case "reveal":
      return c && (
        <div className="grid h-full grid-cols-[3fr_2fr] gap-8">
          <CaseCard c={c} big className="overflow-hidden" />
          <div className="flex flex-col justify-center gap-6">
            <PositionCard side="A" text={c.positionA} big delay={400} />
            <p className="text-center text-5xl font-black">VS</p>
            <PositionCard side="B" text={c.positionB} big delay={700} />
          </div>
        </div>
      );
    case "betting":
      return c && (
        <div className="flex h-full flex-col justify-center gap-8">
          <p className="text-center text-5xl font-black">{c.title}: who&apos;s right? Bet now on your phone!</p>
          <div className="grid grid-cols-2 gap-8">
            {(["A", "B"] as const).map((s) => (
              <div key={s} className={`animate-pop flex min-h-72 flex-col justify-between rounded-3xl p-8 text-white shadow-[0_10px_0_rgba(0,0,0,0.3)] ${SIDE[s].bg}`}>
                <div className="flex items-center gap-4"><AgentIcon side={s} className="h-16 w-16" /><span className="text-5xl font-black">{SIDE[s].name}</span></div>
                <p className="mt-4 text-4xl font-extrabold leading-tight">{s === "A" ? c.positionA : c.positionB}</p>
                {r?.betTotals && <p className="mt-4 text-3xl font-black text-white/90">👥 {r.betTotals[s].players} · 🪙 {r.betTotals[s].tokens}</p>}
              </div>
            ))}
          </div>
        </div>
      );
    case "openings":
    case "debate":
      return c && r && <Debate state={state} />;
    case "judging":
      return (
        <div className="grid h-full place-items-center text-center">
          <div>
            <div className="animate-wiggle inline-block text-[12rem] leading-none" aria-hidden>🔨</div>
            <h2 className="mt-6 text-8xl font-black">The judge is deliberating…</h2>
            <p className="mt-4 text-4xl font-bold text-white/80">Evidence · Logic · Rebuttal · Persuasion</p>
            {c && <div className="mx-auto mt-10 max-w-6xl"><PositionsPanel c={c} big /></div>}
          </div>
        </div>
      );
    case "results": {
      const v = state.verdict;
      if (!v) return <div className="grid h-full place-items-center text-7xl font-black">Settling bets…</div>;
      return (
        <div className="grid h-full grid-cols-[3fr_2fr] gap-10">
          <div className="flex min-h-0 flex-col gap-5">
            <WinnerReveal v={v} big />
            <IncompleteNotice v={v} big />
            <ScoreBars v={v} big />
            <div className="card min-h-0 overflow-hidden p-6 text-2xl font-bold">
              <p className="text-lg font-black uppercase tracking-widest text-court">Judge&apos;s reasoning</p>
              <p className="mt-1 line-clamp-5">{v.explanation}</p>
            </div>
          </div>
          <div className="animate-slide-up" style={{ animationDelay: "1.2s" }}>
            <p className="mb-4 text-center text-4xl font-black">🏆 Leaderboard</p>
            <Podium entries={state.leaderboard} big maxRest={4} />
          </div>
        </div>
      );
    }
    case "cancelled":
      return (
        <div className="grid h-full place-items-center text-center">
          <div>
            <div className="text-[10rem] leading-none" aria-hidden>🚫</div>
            <h2 className="mt-4 text-8xl font-black">Round cancelled</h2>
            <p className="mt-4 text-5xl font-bold text-white/80">All bets have been refunded. Next round coming up…</p>
          </div>
        </div>
      );
  }
}

/** Two-column courtroom: A (red) left, B (blue) right; timeline in the middle, newest at the bottom, ordered by turn. */
function Debate({ state }: { state: UiGameState }) {
  const r = state.round!;
  const c = state.case!;
  const items = [...state.transcript].sort((a, b) => a.sequence - b.sequence);
  const last = items.at(-1);
  const speaking: Side | null = r.nextSpeaker ?? last?.side ?? null;
  const visible = items.slice(-4);
  return (
    <div className="grid h-full grid-cols-[1fr_2.4fr_1fr] gap-6">
      <SideColumn side="A" text={c.positionA} active={speaking === "A"} count={items.filter((i) => i.side === "A").length} />
      <div className="flex min-h-0 flex-col">
        <div className="mb-4 flex items-center justify-center gap-4">
          <span className="rounded-full bg-white px-6 py-2 text-3xl font-black text-court">
            {state.phase === "openings" ? "Opening statements" : `Turn ${Math.max(3, items.length)} of ${r.maxTurns + 2}`}
          </span>
          {r.suggestionsOpen && <span className="animate-pulse rounded-full bg-gold px-5 py-2 text-2xl font-black text-ink">💡 Send your tips now!</span>}
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden">
          {visible.map((a: PublicArgument) => <SpeechBubble key={a.key} arg={a} big newest={a.key === last?.key} />)}
          {r.nextSpeaker && <ThinkingBubble side={r.nextSpeaker} big />}
          {items.length === 0 && !r.nextSpeaker && <p className="text-center text-4xl font-black text-white/70">Court is in session…</p>}
        </div>
      </div>
      <SideColumn side="B" text={c.positionB} active={speaking === "B"} count={items.filter((i) => i.side === "B").length} />
    </div>
  );
}

function SideColumn({ side, text, active, count }: { side: Side; text: string; active: boolean; count: number }) {
  return (
    <div className={`flex flex-col gap-4 rounded-3xl p-6 text-white transition-all duration-300 ${SIDE[side].bg} ${active ? "scale-[1.03] ring-8 ring-white shadow-[0_0_60px_rgba(255,255,255,0.4)]" : "opacity-70"}`}>
      <div className="flex items-center gap-3">
        <AgentIcon side={side} className="h-14 w-14" />
        <span className="text-4xl font-black">{SIDE[side].name}</span>
      </div>
      <p className="text-2xl font-extrabold leading-snug">{text}</p>
      <p className="mt-auto text-xl font-black text-white/80">{active ? "🎙️ Speaking" : ""} · {count} statement{count === 1 ? "" : "s"}</p>
    </div>
  );
}
