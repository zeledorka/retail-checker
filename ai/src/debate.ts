import { generateText as defaultGenerate } from "./providers";
import { selectAudienceBatch, selectInjections } from "./injections";
import { buildAgentPrompt, buildAgentSystem, buildJudgePrompt, buildTurnPrompt, judgeEntries, JUDGE_SYSTEM, STAGE_ORDER } from "./prompts";
import { parseVerdict } from "./judge";
import { parseTurnOutput, validateAudienceAnalysis } from "./grouping";
import { enforceWordLimit, PUBLIC_WORD_LIMIT } from "./wordlimit";
import { RECONCILE_SYSTEM, THEME_DEFAULTS, applyThemeDelta, buildReconcilePrompt, buildThemeBriefing, createAudienceThemeState, ingestSubmissions, markBriefed, nextBatch, parseGroups, pickSurvivor } from "./themes";
import type {
  ArgumentOutput,
  DebateStage,
  EngineConfig,
  GenerateTextFn,
  JudgeInput,
  JudgeResult,
  ModelCallEvent,
  ModelError,
  ModelResult,
  NextTurnInput,
  ReconcileInput,
  ReconcileResult,
  ThemeDelta,
  ThemesStatus,
  Side,
  StageInput,
  StageResult,
  TranscriptEntry,
  TurnResult,
  AudienceReport,
  AudienceAnalysis,
  AudienceThemeState,
  ThemeBriefing,
} from "./types";

export type EngineOptions = {
  /** Injected for tests; defaults to the real provider adapters. */
  generate?: GenerateTextFn;
  /** Called after every model call (success or failure) for logging/metrics. */
  onModelCall?: (event: ModelCallEvent) => void;
};

type FixedStage = Exclude<DebateStage, "turn">;
const SIDES: Side[] = ["A", "B"];
const WINDOW: Record<FixedStage, 1 | 2 | null> = { opening: null, rebuttal: 1, closing: 2 };
const DEFAULT_TURN_WORDS = 45;

export const argumentKey = (roundId: string, stage: DebateStage, side: Side) => `${roundId}:${stage}:${side}`;
export const verdictKey = (roundId: string) => `${roundId}:verdict`;
/** Idempotency key of a sequential turn. A retry with the same transcript length yields the same key. */
export const turnKey = (roundId: string, turn: number, side: Side) => `${roundId}:turn${turn}:${side}`;

/** Only public fields ever leave this module toward a prompt: extra properties on entries are dropped. */
const publicEntry = ({ stage, side, text, turn }: TranscriptEntry): TranscriptEntry =>
  turn === undefined ? { stage, side, text } : { stage, side, text, turn };

/** Returns a message if any of `required` stages is missing an argument from either side. */
function missingHistory(required: DebateStage[], transcript: TranscriptEntry[]): string | null {
  for (const s of required)
    for (const side of SIDES)
      if (!transcript.some((e) => e.stage === s && e.side === side && e.text.trim()))
        return `transcript is missing the ${s} argument of Agent ${side}`;
  return null;
}

export function createDebateEngine(config: EngineConfig, options: EngineOptions = {}) {
  const generate = options.generate ?? defaultGenerate;
  const publicLimit = Math.max(10, config.publicWordLimit ?? PUBLIC_WORD_LIMIT);
  const notify = (e: ModelCallEvent) => {
    try {
      options.onModelCall?.(e);
    } catch {
      /* logging must never break the game */
    }
  };

  async function runStage(stage: FixedStage, input: StageInput): Promise<StageResult> {
    const { roundId, scenario, signal } = input;
    const stageIdx = STAGE_ORDER.indexOf(stage);
    // Only arguments from earlier fixed stages are visible: both agents share the same snapshot.
    const history = (input.transcript ?? [])
      .filter((e) => {
        const i = STAGE_ORDER.indexOf(e.stage);
        return i !== -1 && i < stageIdx;
      })
      .map(publicEntry);
    const missing = missingHistory(STAGE_ORDER.slice(0, stageIdx), history);
    if (missing) {
      const error: ModelError = { kind: "missing_history", message: missing, retryable: false };
      return { ok: false, roundId, stage, arguments: {}, errors: { A: error, B: error } };
    }

    const window = WINDOW[stage];
    const results = await Promise.all(
      SIDES.map(async (side) => {
        const modelCfg = side === "A" ? config.agentA : config.agentB;
        const selected = window ? selectInjections(input.injections, side, window, config.injections) : [];
        const outcome = await generate(modelCfg, {
          system: buildAgentSystem(side, scenario, Math.min(config.argumentMaxWords, publicLimit), input.personas?.[side]),
          prompt: buildAgentPrompt(side, stage, scenario, history, selected),
          signal,
        });
        notify({ roundId, role: side === "A" ? "agentA" : "agentB", stage, outcome });
        return { side, outcome, selected };
      }),
    );

    const args: Partial<Record<Side, ArgumentOutput>> = {};
    const errors: Partial<Record<Side, ModelError>> = {};
    for (const { side, outcome, selected } of results) {
      if (!outcome.ok) {
        errors[side] = outcome.error;
        continue;
      }
      const { text: reply, ...meta } = outcome.result;
      const bounded = enforceWordLimit(reply, publicLimit); // the same final text is what the transcript, the judge and the UI get
      args[side] = {
        roundId,
        stage,
        side,
        text: bounded.text,
        key: argumentKey(roundId, stage, side),
        injectionIdsUsed: selected.map((s) => s.id),
        meta,
        wordLimit: bounded.info,
      };
    }
    if (args.A && args.B) return { ok: true, roundId, stage, arguments: { A: args.A, B: args.B } };
    return { ok: false, roundId, stage, arguments: args, errors };
  }

  /**
   * ONE side's opening argument (same prompt, word limit and bounds as generateOpeningArguments, which runs both sides at
   * once). `timeoutMs` caps this request. Never throws; a failure returns the model error.
   */
  async function generateOpening(input: StageInput & { side: Side; timeoutMs?: number }): Promise<{ ok: true; argument: ArgumentOutput } | { ok: false; error: ModelError }> {
    const { roundId, scenario, side, signal } = input;
    if (side !== "A" && side !== "B") return { ok: false, error: { kind: "config", message: 'side must be "A" or "B"', retryable: false } };
    const base = side === "A" ? config.agentA : config.agentB;
    const modelCfg = input.timeoutMs && input.timeoutMs > 0 ? { ...base, timeoutMs: Math.min(base.timeoutMs, input.timeoutMs) } : base;
    const outcome = await generate(modelCfg, {
      system: buildAgentSystem(side, scenario, Math.min(config.argumentMaxWords, publicLimit), input.personas?.[side]),
      prompt: buildAgentPrompt(side, "opening", scenario, [], []),
      signal,
    });
    notify({ roundId, role: side === "A" ? "agentA" : "agentB", stage: "opening", outcome });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const { text: reply, ...meta } = outcome.result;
    const bounded = enforceWordLimit(reply, publicLimit);
    return { ok: true, argument: { roundId, stage: "opening", side, text: bounded.text, key: argumentKey(roundId, "opening", side), injectionIdsUsed: [], meta, wordLimit: bounded.info } };
  }

  /**
   * Generates exactly one argument for `speaker` from the completed public transcript.
   * The injection snapshot is taken synchronously at call time (before any await): submissions that arrive
   * while the request is running are not included and can be passed on the speaker's next turn.
   * The engine keeps no state; the caller stores the result and appends `argument.injectionIdsUsed`
   * to its consumed set.
   */
  async function generateNextTurn(input: NextTurnInput): Promise<TurnResult> {
    const { roundId, speaker, scenario, signal } = input;
    const history = (input.transcript ?? []).map(publicEntry);
    const turn = history.length + 1;
    const fail = (error: ModelError): TurnResult => ({ ok: false, roundId, turn, speaker, error });
    if (speaker !== "A" && speaker !== "B") return fail({ kind: "config", message: 'speaker must be "A" or "B"', retryable: false });

    // Audience snapshot (synchronous, before any await). Theme mode: ingest into the caller's state and brief the
    // speaker's own cumulative themes. Otherwise: stateless batching; every submission is included, queued, duplicate or invalid.
    let themeState: AudienceThemeState | undefined;
    let briefing: ThemeBriefing | undefined;
    let audience: AudienceReport;
    let selected: { id: string }[] = [];
    if (input.audienceThemeState) {
      const st = input.audienceThemeState;
      if (st.side !== speaker || st.roundId !== roundId)
        return fail({ kind: "config", message: `audienceThemeState belongs to round ${st.roundId} / side ${st.side}, not ${roundId} / ${speaker}`, retryable: false });
      const started = performance.now();
      const ing = ingestSubmissions(st, input.injections, config.injections.maxChars, new Set(input.consumedInjectionIds ?? []));
      themeState = ing.state;
      briefing = buildThemeBriefing(themeState, config.themes, { semanticPending: Boolean(config.reconciler) });
      selected = briefing.representedIds.map((id) => ({ id })); // everything behind the themes the agent was shown
      const ignoredAll = themeState.extras.map((e) => e.id);
      audience = {
        includedIds: briefing.representedIds, // sent to the agent (cumulative, one entry per source submission)
        queuedIds: briefing.omittedIds, // kept in the state, left out of this prompt by the budget; NOT seen by the agent
        duplicateIds: [],
        invalidIds: themeState.invalidIds,
        ignoredIds: ignoredAll,
        processedIds: [...ing.absorbedIds, ...ing.ignoredIds, ...ing.invalidIds], // newly absorbed by this call
        themes: [],
        stats: {
          received: ing.received, otherSide: ing.otherSide, alreadyConsumed: ing.alreadyConsumed + ing.alreadyKnown,
          forSpeaker: briefing.representedIds.length + briefing.omittedIds.length + ignoredAll.length + themeState.invalidIds.length,
          included: briefing.representedIds.length, queued: briefing.omittedIds.length, duplicates: 0, invalid: themeState.invalidIds.length,
          represented: briefing.representedIds.length, absorbed: ing.absorbedIds.length, ignored: ignoredAll.length,
          themes: themeState.themes.length, themesIncluded: briefing.themes.length,
          chars: briefing.chars, processingMs: Math.round((performance.now() - started) * 100) / 100,
        },
      };
    } else {
      const batch = selectAudienceBatch(input.injections, speaker, config.injections, new Set(input.consumedInjectionIds ?? []));
      selected = batch.included;
      audience = batch.report;
    }
    const requested = input.maxWords ?? config.turnMaxWords ?? DEFAULT_TURN_WORDS;
    const maxWords = Math.min(publicLimit, Number.isFinite(requested) ? Math.max(10, Math.min(150, Math.floor(requested))) : DEFAULT_TURN_WORDS);
    const base = speaker === "A" ? config.agentA : config.agentB;
    const modelCfg = input.timeoutMs && input.timeoutMs > 0 ? { ...base, timeoutMs: Math.min(base.timeoutMs, input.timeoutMs) } : base;

    // With an audience briefing the SAME request also returns the agent's grouping of it (one JSON reply, no extra request).
    const structured = Boolean(briefing && briefing.themes.length);
    const outcome = await generate(modelCfg, {
      system: buildAgentSystem(speaker, scenario, maxWords, input.personas?.[speaker], undefined, structured),
      prompt: buildTurnPrompt(speaker, scenario, history, input.audienceThemeState ? [] : (selected as { id: string; text: string }[]), turn, briefing),
      signal,
    });
    notify({ roundId, role: speaker === "A" ? "agentA" : "agentB", stage: "turn", outcome });
    let reply: string;
    let meta: Omit<ModelResult, "text">;
    if (outcome.ok) {
      const { text: t, ...rest } = outcome.result;
      reply = t;
      meta = rest;
    } else {
      // A structured reply cut at the output cap may still hold a COMPLETE public argument (the argument comes first).
      // Only a fully closed "argument" string is kept; plain text cut mid-sentence is never salvaged. No new request is made.
      const e = outcome.error;
      if (!(structured && e.kind === "truncated" && e.partialText && /^\s*(```[a-z]*\s*)?\{/.test(e.partialText))) return fail(e);
      if (!parseTurnOutput(e.partialText).argument) return fail({ ...e, message: `${e.message}; no complete public argument could be recovered from the partial reply` });
      reply = e.partialText;
      meta = { provider: e.provider ?? modelCfg.provider, model: e.model ?? modelCfg.model, latencyMs: e.latencyMs ?? 0, inputTokens: e.inputTokens, outputTokens: e.outputTokens, truncated: true };
    }
    let text = reply;
    let audienceAnalysis: AudienceAnalysis | undefined;
    if (structured && briefing && themeState) {
      const parseStart = performance.now();
      const out = parseTurnOutput(reply);
      if (!out.argument) return fail({ kind: "invalid_output", message: out.problem ?? "empty reply", provider: meta.provider, model: meta.model, retryable: true, latencyMs: meta.latencyMs });
      text = out.argument;
      audienceAnalysis = validateAudienceAnalysis(out.analysis, out.problem, briefing, themeState, 0);
      audienceAnalysis.parseMs = Math.round((performance.now() - parseStart) * 100) / 100;
    }
    // The limit applies to the extracted public argument only (never to the grouping metadata), in code, with no extra request.
    const bounded = enforceWordLimit(text, maxWords);
    return {
      ok: true,
      roundId,
      turn,
      audience,
      ...(themeState && briefing ? { audienceThemeState: markBriefed(themeState, briefing, turn), briefing, ...(audienceAnalysis ? { audienceAnalysis } : {}) } : {}),
      argument: {
        roundId,
        stage: "turn",
        turn,
        side: speaker,
        text: bounded.text,
        key: turnKey(roundId, turn, speaker),
        injectionIdsUsed: selected.map((s) => s.id),
        meta,
        wordLimit: bounded.info,
      },
    };
  }


  /**
   * Incremental semantic reconciliation for ONE side. Ingests `newSubmissions` (exact grouping, no model), then asks
   * the configured reconciler to merge differently worded suggestions that make the same strategic claim. Bounded by
   * config.themes (requests, batch sizes, deadline). Never throws and never loses a submission: failures leave
   * themes unreviewed and still counted. The backend runs this between turns, off the debate path, and stores
   * `state` (or applies `delta` to the latest stored state with applyThemeDelta() when turns ran meanwhile).
   */
  /** Whether semantic grouping is active, and why not when it is not. */
  function themesStatus(): ThemesStatus {
    if (config.reconciler) return config.themesStatus?.state === "enabled" ? config.themesStatus : { state: "enabled", source: "override", provider: config.reconciler.provider, model: config.reconciler.model };
    return config.themesStatus ?? { state: "unavailable", source: "none", reason: "no reconciler configured" };
  }

  async function reconcileAudienceThemes(input: ReconcileInput): Promise<ReconcileResult> {
    const started = Date.now();
    const lim = config.themes ?? {};
    const prev = input.previousState ?? createAudienceThemeState(input.roundId, input.side);
    const empty: ThemeDelta = { merges: [], reviewed: [], failed: [] };
    const errors: ModelError[] = [];
    const ing = prev.side === input.side && prev.roundId === input.roundId ? ingestSubmissions(prev, input.newSubmissions, config.injections.maxChars, new Set(input.consumedInjectionIds ?? [])) : undefined;
    const report = (state: AudienceThemeState, status: "complete" | "partial" | "failed" | "unavailable" | "disabled", requests: number, failedRequests: number, merges: ThemeDelta["merges"], reason?: string) => ({
      status, reason, requests, failedRequests, durationMs: Date.now() - started, merges,
      pendingThemeIds: state.themes.filter((t) => !t.reviewed).map((t) => t.id),
      ingest: ing
        ? { received: ing.received, absorbed: ing.absorbedIds.length, alreadyKnown: ing.alreadyKnown, otherSide: ing.otherSide, alreadyConsumed: ing.alreadyConsumed, invalid: ing.invalidIds.length, newThemes: ing.newThemeIds.length }
        : { received: 0, absorbed: 0, alreadyKnown: 0, otherSide: 0, alreadyConsumed: 0, invalid: 0, newThemes: 0 },
      errors,
    });
    if (!ing) {
      errors.push({ kind: "config", message: "previousState belongs to a different round or side", retryable: false });
      return { state: prev, delta: empty, report: report(prev, "failed", 0, 0, []) };
    }
    let state = ing.state;
    const rec = config.reconciler;
    if (!state.themes.some((t) => !t.reviewed)) return { state, delta: empty, report: report(state, "complete", 0, 0, []) }; // nothing unresolved: no request
    if (!rec) {
      const st = themesStatus();
      return { state, delta: empty, report: report(state, st.state === "disabled" ? "disabled" : "unavailable", 0, 0, [], st.reason ?? "no reconciler configured") };
    }

    const maxRequests = lim.maxRequests ?? THEME_DEFAULTS.maxRequests;
    const deadline = started + (lim.deadlineMs ?? THEME_DEFAULTS.deadlineMs);
    const delta: ThemeDelta = { merges: [], reviewed: [], failed: [] };
    let requests = 0;
    let failedRequests = 0;
    let status: "complete" | "partial" | "failed" = "complete";
    state.reconcileRuns++;
    while (state.themes.some((t) => !t.reviewed)) {
      const { fresh, existing } = nextBatch(state, lim);
      if (!fresh.length) break;
      if (fresh.length + existing.length < 2) {
        fresh.forEach((t) => (t.reviewed = true)); // nothing to compare with yet
        delta.reviewed.push(...fresh.map((t) => t.id));
        continue;
      }
      const left = deadline - Date.now();
      if (requests >= maxRequests || left <= 0 || input.signal?.aborted) {
        status = "partial";
        break;
      }
      requests++;
      const outcome = await generate(
        { ...rec, timeoutMs: Math.min(rec.timeoutMs, left) },
        { system: RECONCILE_SYSTEM, prompt: buildReconcilePrompt(input.scenario, input.side, existing, fresh), signal: input.signal },
      );
      notify({ roundId: input.roundId, role: "themes", stage: "reconcile", outcome });
      const parsed = outcome.ok ? parseGroups(outcome.result.text, new Set(existing.map((t) => t.id)), new Set(fresh.map((t) => t.id))) : undefined;
      if (!outcome.ok || !parsed?.ok) {
        failedRequests++;
        status = "failed";
        errors.push(outcome.ok ? { kind: "invalid_output", message: parsed && !parsed.ok ? parsed.reason : "invalid", provider: outcome.result.provider, model: outcome.result.model, retryable: false, latencyMs: outcome.result.latencyMs } : outcome.error);
        const failedIds = fresh.map((t) => t.id);
        delta.failed.push(...failedIds);
        state = applyThemeDelta(state, { merges: [], reviewed: [], failed: failedIds });
        break; // not retried here; the backend calls again later
      }
      const merges = parsed.groups.map((ids) => ({ into: pickSurvivor(state, ids), from: ids }));
      merges.forEach((m) => (m.from = m.from.filter((id) => id !== m.into)));
      const step: ThemeDelta = { merges, reviewed: fresh.map((t) => t.id), failed: [] };
      state = applyThemeDelta(state, step);
      delta.merges.push(...merges);
      delta.reviewed.push(...step.reviewed);
    }
    if (status === "complete" && state.themes.some((t) => !t.reviewed)) status = "partial";
    return { state, delta, report: report(state, status, requests, failedRequests, delta.merges) };
  }

  async function judgeDebate(input: JudgeInput): Promise<JudgeResult> {
    const { roundId, scenario, signal } = input;
    const key = verdictKey(roundId);
    // Only public arguments reach the judge: no injections, bets, balances or player data.
    const transcript = input.transcript.map(publicEntry);
    // A debate cut short is still judgeable, but both sides must have spoken at least once.
    const silent = SIDES.find((side) => !transcript.some((e) => e.side === side && e.text.trim()));
    if (silent)
      return { ok: false, roundId, key, attempts: 0, error: { kind: "missing_history", message: `transcript has no argument from Agent ${silent}`, retryable: false } };

    const request = { system: JUDGE_SYSTEM, prompt: buildJudgePrompt(scenario, transcript), signal };
    const judgeCfg = input.timeoutMs && input.timeoutMs > 0 ? { ...config.judge, timeoutMs: Math.min(config.judge.timeoutMs, input.timeoutMs) } : config.judge;
    const maxAttempts = 1 + Math.max(0, config.judgeParseRetries);
    let lastError: ModelError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await generate(judgeCfg, request);
      notify({ roundId, role: "judge", stage: "verdict", outcome });
      if (!outcome.ok) return { ok: false, roundId, key, attempts: attempt, error: outcome.error };
      const parsed = parseVerdict(outcome.result.text, judgeEntries(transcript));
      const { text: _raw, ...meta } = outcome.result;
      if (parsed.ok) return { ok: true, roundId, key, verdict: parsed.verdict, meta, attempts: attempt };
      lastError = {
        kind: "invalid_output",
        message: parsed.reason,
        provider: meta.provider,
        model: meta.model,
        retryable: false,
        latencyMs: meta.latencyMs,
      };
    }
    return { ok: false, roundId, key, attempts: maxAttempts, error: lastError! };
  }

  return {
    config,
    runStage,
    generateNextTurn,
    generateOpening,
    reconcileAudienceThemes,
    themesStatus,
    generateOpeningArguments: (input: StageInput) => runStage("opening", input),
    generateRebuttals: (input: StageInput) => runStage("rebuttal", input),
    generateClosingArguments: (input: StageInput) => runStage("closing", input),
    judgeDebate,
  };
}

export type DebateEngine = ReturnType<typeof createDebateEngine>;
