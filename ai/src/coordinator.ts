import type { DebateEngine } from "./debate";
import { applyThemeDelta, createAudienceThemeState, ingestSubmissions, markBriefed } from "./themes";
import type { AudienceInjection, AudienceThemeState, NextTurnInput, ReconcileReport, ReconcileResult, Scenario, Side, ThemeBriefing, TurnResult } from "./types";

const SIDES: Side[] = ["A", "B"];

export type CoordinatorOptions = {
  roundId: string;
  scenario: Scenario;
  /** Resume from stored states (e.g. after a restart). */
  restore?: Partial<Record<Side, AudienceThemeState>>;
  /** A theme whose grouping failed this many times is not retried automatically (default 3). It stays counted and briefed. */
  maxAttempts?: number;
  signal?: AbortSignal;
};

export type SideAudit = {
  /** Distinct submission IDs passed to submit() for this side. */
  received: number;
  /** Valid ones absorbed into a theme (exact-wording grouping). */
  ingested: number;
  invalid: number;
  /** Extra submissions of an already-counted player: kept, never counted. */
  ignored: number;
  themes: number;
  /** Themes whose semantic grouping is still pending. */
  awaiting: number;
  /** Received IDs found neither in a theme nor among the invalid ones. Must be 0. */
  missing: number;
  missingIds: string[];
};

/**
 * RESPONSIBILITIES. Backend: player identity, one submission per player per round, side assignment, timing, persistence.
 * This module: validates and ingests what it is given, keeps cumulative per-side state, builds the briefing and asks the
 * debating agent (one request) for the argument plus its private grouping of the briefing.
 * TIMING RULE: a submission passed to submit() / nextTurn({injections}) BEFORE nextTurn() builds its request is in that
 * request's briefing (settle -> ingest -> state update -> briefing -> request). One passed while the request is running is
 * in the state and appears in the speaker's next request. Submissions of the other side never enter a side's briefing.
 *
 * Per-round helper that runs the whole theme flow automatically: ingest, background semantic grouping, bounded wait,
 * briefing marks. It holds the states only for the lifetime of the object; `states()` returns what to persist. Reconciliation
 * is scheduled whenever unresolved themes exist and a reconciler is available, never blocks a turn longer than `waitMs`,
 * and makes no request when nothing is unresolved.
 */
export function createThemeCoordinator(engine: DebateEngine, opts: CoordinatorOptions) {
  const { roundId, scenario } = opts;
  const maxAttempts = opts.maxAttempts ?? 3;
  const st: Record<Side, AudienceThemeState> = {
    A: opts.restore?.A ?? createAudienceThemeState(roundId, "A"),
    B: opts.restore?.B ?? createAudienceThemeState(roundId, "B"),
  };
  const received: Record<Side, Set<string>> = { A: new Set(), B: new Set() };
  const pending: Partial<Record<Side, { promise: Promise<ReconcileResult>; startedTurn?: number }>> = {};
  const runs: { side: Side; report: ReconcileReport }[] = [];
  const grouping = { runs: 0, requests: 0, failedRequests: 0, totalMs: 0, waitedMs: 0 };

  const unresolved = (side: Side) => (engine.themesStatus().state === "enabled" ? st[side].themes.filter((t) => !t.reviewed) : []); // only meaningful with the optional reconciler
  const eligible = (side: Side) => unresolved(side).some((t) => t.attempts < maxAttempts);

  /** Starts background grouping for `side` if there is something unresolved. Returns true if a request run was started. */
  function schedule(side: Side, turn?: number): boolean {
    if (pending[side] || !eligible(side) || engine.themesStatus().state !== "enabled") return false;
    pending[side] = { startedTurn: turn, promise: engine.reconcileAudienceThemes({ roundId, side, scenario, previousState: st[side], signal: opts.signal }) };
    return true;
  }

  /** Adopts a finished reconciliation (waiting at most `waitMs`). Returns its report, or undefined if none finished. */
  async function settle(side: Side, waitMs = 0): Promise<ReconcileReport | undefined> {
    const p = pending[side];
    if (!p) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    const r = await Promise.race([p.promise, new Promise<null>((res) => (timer = setTimeout(() => res(null), Math.max(0, waitMs))))]);
    clearTimeout(timer);
    grouping.waitedMs += Date.now() - t0;
    if (!r) return undefined;
    delete pending[side];
    st[side] = applyThemeDelta(st[side], r.delta);
    runs.push({ side, report: r.report });
    grouping.runs++;
    grouping.requests += r.report.requests;
    grouping.failedRequests += r.report.failedRequests;
    grouping.totalMs += r.report.durationMs;
    if (r.report.status !== "failed") schedule(side); // more unresolved themes arrived or were left over; a failure waits for the next turn
    return r.report;
  }

  /** Ingests submissions of either side immediately (deterministic, no model) and schedules background grouping. */
  function submit(submissions: AudienceInjection[], turn?: number) {
    const summary: Partial<Record<Side, { absorbed: number; invalid: number; alreadyKnown: number; newThemes: number }>> = {};
    for (const side of SIDES) {
      const mine = submissions.filter((s) => s.side === side);
      mine.forEach((s) => received[side].add(s.id));
      const r = ingestSubmissions(st[side], mine, engineMaxChars);
      st[side] = r.state;
      summary[side] = { absorbed: r.absorbedIds.length, invalid: r.invalidIds.length, alreadyKnown: r.alreadyKnown, newThemes: r.newThemeIds.length };
      schedule(side, turn);
    }
    return summary;
  }
  const engineMaxChars = engine.config.injections.maxChars;

  /**
   * One debate turn on the latest COMPLETED theme state. Adopts finished reconciliations (waiting at most `waitMs`, default 0 =
   * never wait), retries pending grouping in the background, then generates the turn and marks the briefed themes.
   */
  async function nextTurn(input: Omit<NextTurnInput, "roundId" | "scenario" | "audienceThemeState"> & { waitMs?: number }) {
    const turn = (input.transcript?.length ?? 0) + 1;
    for (const side of SIDES) await settle(side, input.waitMs ?? 0);
    if (input.injections?.length) submit(input.injections, turn);
    for (const side of SIDES) schedule(side, turn);
    const snapshot = st[input.speaker]; // includes just-submitted exact groupings
    const { waitMs: _w, injections: _i, ...rest } = input;
    const result: TurnResult = await engine.generateNextTurn({ ...rest, roundId, scenario, audienceThemeState: snapshot });
    let briefing: ThemeBriefing | undefined;
    if (result.ok && result.briefing) {
      briefing = result.briefing;
      st[input.speaker] = markBriefed(st[input.speaker], briefing, result.turn); // on the latest state, not the snapshot
    }
    return { result, briefing, awaitingReconciliation: unresolved(input.speaker).length };
  }

  /** Waits (bounded) for everything in flight. */
  async function idle(timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (let i = 0; i < 6 && SIDES.some((s) => pending[s]); i++) for (const side of SIDES) await settle(side, Math.max(0, end - Date.now()));
  }

  function audit(side: Side): SideAudit {
    const inState = new Set([...st[side].themes.flatMap((t) => t.sourceIds), ...st[side].invalidIds, ...st[side].extras.map((e) => e.id)]);
    const missingIds = [...received[side]].filter((id) => !inState.has(id));
    return {
      received: received[side].size,
      ingested: st[side].themes.reduce((n, t) => n + t.sourceIds.length, 0) + st[side].extras.length,
      invalid: st[side].invalidIds.length,
      ignored: st[side].extras.length,
      themes: st[side].themes.length,
      awaiting: unresolved(side).length,
      missing: missingIds.length,
      missingIds: missingIds.slice(0, 20),
    };
  }

  /**
   * Submissions of `side` that are in the state but were never part of any briefing: they arrived after the side's last
   * request, or were omitted by the prompt budget every time. They could not have influenced any argument.
   */
  function neverBriefed(side: Side): string[] {
    return st[side].themes.filter((t) => t.briefedTurns.length === 0).flatMap((t) => t.sourceIds);
  }

  /** Human-readable semantic-grouping status for logs and dashboards. */
  function semanticStatus() {
    const s = engine.themesStatus();
    const awaiting = unresolved("A").length + unresolved("B").length;
    const text =
      s.state === "enabled"
        ? awaiting ? `optional reconciler active, ${awaiting} theme(s) awaiting reconciliation` : "optional reconciler active, nothing awaiting reconciliation"
        : s.state === "disabled" ? "no separate reconciliation: the debating agent groups related wordings inside its own turn request" : `reconciler unavailable (${s.reason ?? "unknown"}); the debating agent still groups related wordings itself`;
    return { ...s, awaiting, text };
  }

  return { submit, settle, schedule, nextTurn, idle, audit, neverBriefed, semanticStatus, state: (side: Side) => st[side], states: () => ({ A: st.A, B: st.B }), runs: () => runs, grouping: () => ({ ...grouping }), inFlight: (side: Side) => Boolean(pending[side]) };
}
export type ThemeCoordinator = ReturnType<typeof createThemeCoordinator>;
