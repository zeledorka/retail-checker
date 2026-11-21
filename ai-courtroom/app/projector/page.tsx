"use client";
// Projector: read-only 16:9 courtroom. Host dock is a fixed overlay rendered only after admin unlock
// (press U, or click the bottom-right corner). ?view=display never shows the dock.
import { useCallback, useEffect, useState } from "react";
import { useGameState } from "@/lib/useGameState";
import { useAdmin } from "@/lib/useAdmin";
import { useCountdown } from "@/lib/useCountdown";
import type { CriterionScores, PublicArgument, Side, UiGameState, UiVerdict } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { CaseCard } from "@/components/CaseCard";
import { PositionCard, PositionsPanel } from "@/components/PositionsPanel";
import { SpeechBubble, ThinkingBubble } from "@/components/SpeechBubble";
import { IncompleteNotice } from "@/components/VerdictPanel";
import { Podium } from "@/components/Leaderboard";
import { AgentIcon, PHASE_LABEL, SIDE } from "@/components/sides";
import { HostDock, UnlockDialog } from "@/components/HostDock";

const IDLE_MS = 3000;
/** Length of the projector's "Judge Verdict" screen before it moves on to "Winner and Leaderboard". */
const VERDICT_SCREEN_SECONDS = 15; // not exported: Next.js page files may only export the page + route config

type ResultsStage = {
  /** null outside a results phase that has a verdict. "pending" = not mounted yet (clock/storage unread): neutral screen. */
  screen: "pending" | "verdict" | "leaderboard" | null;
  verdictStart: number | null;
  verdictEndsAt: number | null;
  skip: () => void;
};

/**
 * Splits the server's results phase into two client-side sub-screens. The 15s is measured from the SERVER's results
 * phase start (round.phaseStartedAt) + the measured clock offset, so a refresh resumes at the right point; if that is
 * past 15s the leaderboard shows straight away. Never moves on from the leaderboard by itself: only a new server
 * phase does. "Skip" is client-side only, remembered per round id for this tab.
 */
function useResultsStage(state: UiGameState | null, offset: number): ResultsStage {
  const r = state?.round ?? null;
  const roundId = r?.id ?? null;
  const inResults = state?.phase === "results" && !!state.verdict;
  const serverStart = inResults ? r?.phaseStartedAt ?? null : null;
  const [fallbackStart, setFallbackStart] = useState<number | null>(null);
  const [skipped, setSkipped] = useState(false);
  /** Round id whose sessionStorage (skip flag / fallback start) has been read. Only ever set inside the effect. */
  const [readFor, setReadFor] = useState<string | null>(null);

  // Clock + storage are read only here (after mount), never during render.
  useEffect(() => {
    if (!inResults || !roundId) { setFallbackStart(null); setSkipped(false); setReadFor(null); return; }
    setSkipped(sessionStorage.getItem(`aic:verdict-skip:${roundId}`) === "1");
    if (serverStart === null) {
      // TODO: ask Dev 3 for results phase start timestamp (falls back to when this tab first saw the results phase).
      const key = `aic:results-seen:${roundId}`;
      let seen = sessionStorage.getItem(key);
      if (!seen) { seen = String(Date.now() + offset); sessionStorage.setItem(key, seen); }
      setFallbackStart(Number(seen));
    }
    setReadFor(roundId);
    // offset is intentionally not a dependency: the first-seen time must not move as the offset is refined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inResults, roundId, serverStart]);

  const verdictStart = serverStart ?? fallbackStart;
  const verdictEndsAt = verdictStart !== null ? verdictStart + VERDICT_SCREEN_SECONDS * 1000 : null;
  const { expired, isReady } = useCountdown(verdictEndsAt, offset);
  const skip = useCallback(() => {
    if (roundId) sessionStorage.setItem(`aic:verdict-skip:${roundId}`, "1");
    setSkipped(true);
  }, [roundId]);

  // Until storage is read for THIS round and the countdown has a real clock, we can't tell verdict from leaderboard
  // (>15s elapsed / skipped): show a neutral screen instead of flashing the wrong one.
  const ready = readFor === roundId && verdictEndsAt !== null && isReady;
  const screen = !inResults ? null : !ready ? "pending" : skipped || expired ? "leaderboard" : "verdict";
  return { screen, verdictStart, verdictEndsAt, skip };
}

export default function ProjectorPage() {
  const { state, serverOffset, error, refetch } = useGameState({ asPlayer: false });
  const adm = useAdmin();
  const results = useResultsStage(state, serverOffset);
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
      <Courtroom state={state} offset={serverOffset} joinUrl={joinUrl} results={results} />
      {error && <p className="fixed left-1/2 top-2 -translate-x-1/2 rounded-full bg-agent-a px-4 py-1 text-sm font-black">📡 Reconnecting…</p>}

      {canDock && adm.secret && !dockHidden && (
        <HostDock state={state} secret={adm.secret} onLock={adm.lock} refetch={refetch} idle={idle}
          onSkipVerdict={results.screen === "verdict" ? results.skip : undefined} />
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

function Courtroom({ state, offset, joinUrl, results }: { state: UiGameState | null; offset: number; joinUrl: string; results: ResultsStage }) {
  if (!state) {
    return <div className="grid h-full place-items-center"><Title /></div>;
  }
  const r = state.round;
  // Header title + timer follow the results sub-screen; the leaderboard has no timer (waits for the host).
  const title = results.screen === "verdict" ? "Judge's verdict" : results.screen === "leaderboard" ? "Winner & leaderboard"
    : state.phase === "results" ? PHASE_LABEL.judging : PHASE_LABEL[state.phase];
  const timer = results.screen === "verdict"
    ? { deadline: results.verdictEndsAt, start: results.verdictStart }
    : state.phase === "results" ? null : { deadline: r?.phaseEndsAt, start: r?.phaseStartedAt };
  return (
    <div className="flex h-full flex-col px-7 pb-7 pt-4">
      <header className="flex h-20 shrink-0 items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <span className="text-4xl" aria-hidden>⚖️</span>
          <div>
            <p className="text-2xl font-black leading-none">AI Courtroom</p>
            {r && <p className="text-base font-bold text-white/70">Round {r.number}{state.game.maxRounds ? ` of ${state.game.maxRounds}` : ""} · join at {joinUrl}</p>}
          </div>
        </div>
        {state.phase !== "lobby" && (
          <h1 key={title} className="animate-banner text-[clamp(2rem,2.6vw,3.1rem)] font-black drop-shadow-[0_4px_0_rgba(0,0,0,0.25)]">{title}</h1>
        )}
        <div className="flex w-24 justify-end">
          {timer && <Countdown deadline={timer.deadline} start={timer.start} offset={offset} size={92} />}
        </div>
      </header>

      <section key={`${state.phase}:${results.screen ?? ""}`} className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Stage state={state} joinUrl={joinUrl} results={results} />
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

function Stage({ state, joinUrl, results }: { state: UiGameState; joinUrl: string; results: ResultsStage }) {
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
      return <Judging state={state} />;
    case "results": {
      const v = state.verdict;
      // Verdict not in the state yet: keep the judging screen rather than an empty verdict.
      // Also while the sub-stage is still "pending" (before mount), so neither results screen flashes.
      if (!v || !results.screen || results.screen === "pending") return <Judging state={state} />;
      return results.screen === "verdict" ? <VerdictScreen v={v} /> : <WinnerScreen v={v} state={state} />;
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

function Judging({ state }: { state: UiGameState }) {
  const c = state.case;
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
}

// ---- Results screen 1: Judge Verdict (timed) -------------------------------------------------------------------------

const DIMS: { key: keyof CriterionScores; label: string }[] = [
  { key: "evidence", label: "Evidence" }, { key: "logic", label: "Logic" },
  { key: "rebuttal", label: "Rebuttal" }, { key: "persuasion", label: "Persuasion" },
];

/** Full verdict on one 16:9 screen: winner strip, A vs B score cards, then the full reasoning (scales, scrolls in its own panel). */
function VerdictScreen({ v }: { v: UiVerdict }) {
  const w = SIDE[v.winner];
  const words = v.explanation.split(/\s+/).length + (v.decisiveExchange?.description.split(/\s+/).length ?? 0);
  const textSize = words > 180 ? "text-[clamp(0.9rem,1.05vw,1.3rem)]" : words > 100 ? "text-[clamp(1rem,1.25vw,1.6rem)]" : "text-[clamp(1.1rem,1.5vw,1.9rem)]";
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className={`animate-pop flex shrink-0 items-center gap-4 rounded-2xl px-6 py-3 text-white shadow-[0_6px_0_rgba(0,0,0,0.3)] ${w.bg}`}>
        <AgentIcon side={v.winner} className="h-12 w-12 shrink-0" />
        <p className="text-[clamp(1.6rem,2.4vw,3rem)] font-black leading-none">⚖️ The court finds for {w.name}</p>
        {v.summary && <p className="ml-auto max-w-[45%] text-right text-[clamp(1rem,1.3vw,1.6rem)] font-bold leading-snug text-white/90">{v.summary}</p>}
      </div>
      {!v.complete && <div className="shrink-0"><IncompleteNotice v={v} big /></div>}

      <div className="grid shrink-0 grid-cols-2 gap-6">
        <AgentScoreCard v={v} side="A" />
        <AgentScoreCard v={v} side="B" />
      </div>

      <div className={`card animate-slide-up flex min-h-0 flex-1 flex-col overflow-y-auto p-5 font-bold leading-snug ${textSize}`} style={{ animationDelay: "500ms" }}>
        <p className="text-[0.7em] font-black uppercase tracking-widest text-court">Judge&apos;s reasoning</p>
        <p className="mt-1">{v.explanation}</p>
        {v.decisiveExchange && <p className="mt-2 text-[0.9em]"><span className="font-black text-court">Decisive moment:</span> {v.decisiveExchange.description}</p>}
      </div>
    </div>
  );
}

function AgentScoreCard({ v, side }: { v: UiVerdict; side: Side }) {
  const s = SIDE[side];
  const won = v.winner === side;
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), 350); return () => clearTimeout(t); }, []);
  const sc = v.scores?.[side];
  const total = sc ? sc.evidence + sc.logic + sc.rebuttal + sc.persuasion : null;
  const notes = [...(v.strengths?.[side] ?? []).map((t) => `✅ ${t}`), ...(v.weaknesses?.[side] ?? []).map((t) => `⚠️ ${t}`)];
  return (
    <div className={`card animate-slide-up overflow-hidden ${won ? `ring-8 ${s.ring}` : "opacity-90"}`} style={{ animationDelay: side === "A" ? "150ms" : "300ms" }}>
      <div className={`flex items-center gap-3 px-5 py-2 text-white ${s.bg}`}>
        <AgentIcon side={side} className="h-9 w-9" />
        <span className="text-3xl font-black">{s.name}</span>
        {won && <span className="rounded-full bg-white px-3 py-0.5 text-lg font-black text-ink">🏆 WINNER</span>}
        <span className="ml-auto text-right font-black leading-none">
          {total !== null && <span className="block text-3xl">{total}<span className="text-lg text-white/80">/40</span></span>}
          {v.overall && <span className="block text-sm text-white/80">avg {v.overall[side]}</span>}
        </span>
      </div>
      <div className="grid gap-2 px-5 py-3">
        {sc ? DIMS.map((d, i) => (
          <div key={d.key} className="grid grid-cols-[8.5rem_1fr_2.5rem] items-center gap-3 text-xl font-black">
            <span className="text-ink/70">{d.label}</span>
            <div className="h-5 overflow-hidden rounded-full bg-gray-200">
              <div className={`h-full rounded-full ${s.bg}`} style={{ width: on ? `${sc[d.key] * 10}%` : "0%", transition: `width 900ms cubic-bezier(.2,1.2,.4,1) ${i * 150}ms` }} />
            </div>
            <span className="text-right">{sc[d.key]}</span>
          </div>
        )) : <p className="font-bold text-ink/60">Scores not available for this verdict.</p>}
        {notes.length > 0 && (
          <ul className="mt-1 grid gap-0.5 text-base font-bold text-ink/80">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- Results screen 2: Winner and Leaderboard (until the next round) -------------------------------------------------

function WinnerScreen({ v, state }: { v: UiVerdict; state: UiGameState }) {
  const s = SIDE[v.winner];
  return (
    // Winner banner on top, leaderboard below. min-h-full (not h-full): if the leaderboard is taller than the
    // screen, the courtroom section scrolls instead of clipping.
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-6 pb-4">
      <div className={`animate-pop flex items-center justify-center gap-4 rounded-2xl px-6 py-3 text-white shadow-[0_6px_0_rgba(0,0,0,0.3)] ${s.bg}`}>
        <AgentIcon side={v.winner} className="h-14 w-14 shrink-0" />
        <div className="text-center">
          <p className="text-[clamp(1.8rem,3.2vw,4rem)] font-black leading-none drop-shadow-[0_6px_0_rgba(0,0,0,0.25)]">{s.name} wins the case!</p>
          {v.summary && <p className="mt-2 text-[clamp(0.9rem,1.2vw,1.5rem)] font-bold text-white/90">{v.summary}</p>}
        </div>
        <AgentIcon side={v.winner} className="h-14 w-14 shrink-0" />
      </div>
      <div className="flex flex-col">
        <p className="mb-3 text-center text-5xl font-black">🏆 Leaderboard</p>
        <Podium entries={state.leaderboard} big maxRest={5} showDeltas />
      </div>
    </div>
  );
}

// ---- Debate --------------------------------------------------------------------------------------------------------

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
