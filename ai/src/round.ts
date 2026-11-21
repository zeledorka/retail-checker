import { z } from "zod";
import { loadEngineConfig } from "./config";
import { createDebateEngine, argumentKey, turnKey, type EngineOptions } from "./debate";
import { ingestSubmissions, parseAudienceThemeState, createAudienceThemeState } from "./themes";
import type {
  AudienceAnalysis,
  AudienceInjection,
  AudienceReport,
  AudienceThemeState,
  EngineConfig,
  JudgeVerdict,
  ModelError,
  ModelErrorKind,
  Scenario,
  Side,
  ThemeBriefing,
  TranscriptEntry,
} from "./types";

/**
 * Production entry point for the game backend (Developer 3). A thin layer over the existing engine: it keeps NO state of its
 * own. The caller stores one JSON document per round (AiRoundState), loads it for each request, passes it to one function and
 * saves the returned state. See INTEGRATION.md.
 */

/** One audience message. `playerId` is REQUIRED for distinct-supporter counting; the backend enforces one per player per round. */
export type AudienceSubmission = AudienceInjection;

/**
 * The complete, serialisable state of one AI round (plain JSON). SERVER-ONLY: it holds both sides' private audience messages
 * and player ids. Never send it to a browser; use publicRoundView().
 */
export type AiRoundState = {
  version: 1;
  roundId: string;
  /** Increments on every state change: use it for compare-and-swap when saving to the database. */
  revision: number;
  /** Sequential debate turns in the round (default 8). */
  maxTurns: number;
  /** Public scenario with the locked interpretations (never changed by the AI subsystem). */
  scenario: Scenario;
  /** The public transcript: opening A, opening B, then turns 3.. in order. */
  transcript: TranscriptEntry[];
  /** PRIVATE per-side audience memory (messages, player ids, wording counts, briefing history). */
  audience: Record<Side, AudienceThemeState>;
  /** Set once the judge has ruled; the round is then closed. */
  verdict?: JudgeVerdict;
  closed: boolean;
};

export type AiErrorCode = "invalid_scenario" | "invalid_state" | "wrong_turn" | "out_of_order" | "not_ready" | "round_complete" | "round_closed" | "model_error";
export type AiError = {
  code: AiErrorCode;
  message: string;
  /** Whether calling the SAME function again may succeed (model/timeouts) or never will (bad input, wrong order). */
  retryable: boolean;
  /** true when a provider request was sent (it may have been billed even though it failed). */
  modelCalled: boolean;
  modelErrorKind?: ModelErrorKind;
  /** Tokens the provider reported for the failed request, when known. */
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** What the frontend may show. `sequence` is the position in the public transcript: opening A = 1, opening B = 2, turns 3..10. */
export type PublicArgument = { roundId: string; stage: "opening" | "turn"; sequence: number; debateTurn?: number; side: Side; text: string; key: string };

/** Server-side telemetry for logging and cost tracking (not for the browser). */
export type CallTelemetry = { provider: string; model: string; latencyMs: number; inputTokens?: number; outputTokens?: number; truncated?: boolean; shortened?: boolean; wordCountBefore?: number; wordCountAfter?: number };

export type OpeningStep =
  | { ok: true; state: AiRoundState; argument: PublicArgument; reused: boolean; telemetry?: CallTelemetry }
  | { ok: false; state: AiRoundState; error: AiError };

export type TurnStep =
  | {
      ok: true;
      state: AiRoundState;
      argument: PublicArgument;
      /** true: this turn already existed in the state; NO model request was made and `private` is absent. */
      reused: boolean;
      telemetry?: CallTelemetry;
      /** SERVER-ONLY: the speaking side's audience bookkeeping for this turn. Never publish it or show it to the other side or the judge. */
      private?: { audience: AudienceReport; analysis?: AudienceAnalysis; briefing?: ThemeBriefing; originalText?: string };
    }
  | { ok: false; state: AiRoundState; error: AiError };

export type JudgeStep =
  | {
      ok: true;
      state: AiRoundState;
      verdict: JudgeVerdict;
      /** false when the judge ruled on a debate that did not reach maxTurns (deadline): the verdict says what was judged. */
      complete: boolean;
      turnsCompleted: number;
      reused: boolean;
      telemetry?: CallTelemetry & { attempts: number };
    }
  | { ok: false; state: AiRoundState; error: AiError };

export type PublicRoundView = {
  roundId: string;
  revision: number;
  status: "created" | "opening_in_progress" | "debating" | "ready_for_judge" | "judged";
  scenario: Scenario;
  transcript: PublicArgument[];
  turnsCompleted: number;
  maxTurns: number;
  verdict?: JudgeVerdict;
};

// ---------------------------------------------------------------------------------------------------------------------
// Validation, state creation, serialisation
// ---------------------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const scenarioSchema = z.object({
  title: text(200),
  description: text(2000),
  evidence: z.array(text(400)).min(1).max(20),
  interpretationA: text(500),
  interpretationB: text(500),
});
const roundIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "roundId must be 1-128 characters of letters, digits and _ . : -");
const entrySchema = z.object({ stage: z.enum(["opening", "turn"]), side: z.enum(["A", "B"]), text: z.string().min(1), turn: z.number().int().optional() });
const verdictSchema = z.custom<JudgeVerdict>((v) => typeof v === "object" && v !== null && (v as JudgeVerdict).winner !== undefined && (v as JudgeVerdict).scores !== undefined);
const stateSchema = z.object({
  version: z.literal(1),
  roundId: roundIdSchema,
  revision: z.number().int().min(0),
  maxTurns: z.number().int().min(1).max(12),
  scenario: scenarioSchema,
  transcript: z.array(entrySchema).max(14),
  audience: z.object({ A: z.unknown(), B: z.unknown() }),
  verdict: verdictSchema.optional(),
  closed: z.boolean(),
});

const err = (code: AiErrorCode, message: string, retryable = false, modelCalled = false): AiError => ({ code, message, retryable, modelCalled });
const RETRYABLE_KINDS: ModelErrorKind[] = ["timeout", "connection", "rate_limit", "provider_error", "invalid_output", "truncated", "empty_output"];
function fromModel(e: ModelError): AiError {
  const sent = e.kind !== "config" && e.kind !== "missing_history";
  return {
    code: "model_error",
    message: e.message,
    retryable: RETRYABLE_KINDS.includes(e.kind) || e.retryable,
    modelCalled: sent,
    modelErrorKind: e.kind,
    ...(e.inputTokens !== undefined || e.outputTokens !== undefined ? { usage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens } } : {}),
  };
}

/**
 * Creates the first state of a round from an ALREADY VALIDATED scenario with two locked, different interpretations. The AI
 * subsystem never generates or changes them. Makes no model request.
 */
export function startRound(input: { roundId: string; scenario: Scenario; maxTurns?: number }): { ok: true; state: AiRoundState } | { ok: false; error: AiError } {
  const id = roundIdSchema.safeParse(input?.roundId);
  if (!id.success) return { ok: false, error: err("invalid_scenario", id.error.issues[0].message) };
  const sc = scenarioSchema.safeParse(input.scenario);
  if (!sc.success) return { ok: false, error: err("invalid_scenario", `scenario ${sc.error.issues[0].path.join(".") || "root"}: ${sc.error.issues[0].message}`) };
  const s = sc.data;
  if (s.interpretationA.toLowerCase() === s.interpretationB.toLowerCase()) return { ok: false, error: err("invalid_scenario", "interpretationA and interpretationB must be different") };
  const maxTurns = input.maxTurns ?? 8;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 12) return { ok: false, error: err("invalid_scenario", "maxTurns must be an integer from 1 to 12") };
  return {
    ok: true,
    state: { version: 1, roundId: id.data, revision: 0, maxTurns, scenario: s, transcript: [], audience: { A: createAudienceThemeState(id.data, "A"), B: createAudienceThemeState(id.data, "B") }, closed: false },
  };
}

/** The canonical JSON to store (e.g. in a Supabase jsonb column). */
export const serializeRound = (state: AiRoundState): string => JSON.stringify(state);

/** Restores and VALIDATES a stored state (JSON string or parsed object). Never throws. */
export function parseRoundState(raw: unknown): { ok: true; state: AiRoundState } | { ok: false; error: AiError } {
  const bad = (m: string) => ({ ok: false as const, error: err("invalid_state", m) });
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return bad("stored state is not valid JSON");
    }
  }
  const p = stateSchema.safeParse(data);
  if (!p.success) return bad(`stored state failed validation: ${p.error.issues[0].path.join(".") || "root"}: ${p.error.issues[0].message}`);
  const v = p.data;
  const a = parseAudienceThemeState(v.audience.A);
  const b = parseAudienceThemeState(v.audience.B);
  if (!a.ok) return bad(`audience A: ${a.reason}`);
  if (!b.ok) return bad(`audience B: ${b.reason}`);
  if (a.state.side !== "A" || b.state.side !== "B" || a.state.roundId !== v.roundId || b.state.roundId !== v.roundId) return bad("audience state does not belong to this round and side");
  // transcript shape: openings (A then B) first, then turns numbered 3.. alternating A, B, A, B ...
  const t = v.transcript;
  const openings = t.filter((e) => e.stage === "opening");
  const turns = t.filter((e) => e.stage === "turn");
  if (t.slice(0, openings.length).some((e) => e.stage !== "opening")) return bad("transcript: openings must come first");
  if (openings.some((e, i) => e.side !== (["A", "B"] as const)[i])) return bad("transcript: openings must be A then B, at most once each");
  if (turns.length && openings.length < 2) return bad("transcript: turns exist before both openings");
  if (turns.length > v.maxTurns) return bad("transcript: more turns than maxTurns");
  if (turns.some((e, i) => e.turn !== i + 3 || e.side !== (i % 2 === 0 ? "A" : "B"))) return bad("transcript: turns must be numbered 3.. and alternate A, B, A, B");
  if (v.verdict && !v.closed) return bad("a stored verdict requires a closed round");
  const { verdict, ...rest } = v;
  return { ok: true, state: { ...rest, transcript: t as TranscriptEntry[], audience: { A: a.state, B: b.state }, ...(verdict ? { verdict } : {}) } };
}

const turnsOf = (s: AiRoundState) => s.transcript.filter((e) => e.stage === "turn").length;
const openingOf = (s: AiRoundState, side: Side) => s.transcript.find((e) => e.stage === "opening" && e.side === side);

function publicArgument(state: AiRoundState, entry: TranscriptEntry): PublicArgument {
  const sequence = state.transcript.indexOf(entry) + 1;
  return {
    roundId: state.roundId,
    stage: entry.stage === "opening" ? "opening" : "turn",
    sequence,
    ...(entry.stage === "turn" ? { debateTurn: sequence - 2 } : {}),
    side: entry.side,
    text: entry.text,
    key: entry.stage === "opening" ? argumentKey(state.roundId, "opening", entry.side) : turnKey(state.roundId, entry.turn ?? sequence, entry.side),
  };
}

/** What the frontend may receive: scenario, public transcript, progress and the verdict. No audience data, no player ids. */
export function publicRoundView(state: AiRoundState): PublicRoundView {
  const turns = turnsOf(state);
  const status: PublicRoundView["status"] = state.verdict ? "judged" : turns >= state.maxTurns ? "ready_for_judge" : turns > 0 ? "debating" : state.transcript.length >= 2 ? "debating" : state.transcript.length === 1 ? "opening_in_progress" : "created";
  return { roundId: state.roundId, revision: state.revision, status, scenario: state.scenario, transcript: state.transcript.map((e) => publicArgument(state, e)), turnsCompleted: turns, maxTurns: state.maxTurns, ...(state.verdict ? { verdict: state.verdict } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The three model-backed steps
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `config` defaults to loadEngineConfig(): Claude Sonnet 5.5 for Agent A, Agent B and the judge at low effort (env overrides
 * per role). `options.generate` lets tests inject a mock provider.
 */
export function createAiRound(config: EngineConfig = loadEngineConfig(), options: EngineOptions = {}) {
  const engine = createDebateEngine(config, options);
  const telemetryOf = (m: { provider: string; model: string; latencyMs: number; inputTokens?: number; outputTokens?: number; truncated?: boolean }, w?: { shortened: boolean; originalWords: number; finalWords: number }): CallTelemetry => ({
    provider: m.provider,
    model: m.model,
    latencyMs: m.latencyMs,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    ...(m.truncated ? { truncated: true } : {}),
    ...(w ? { shortened: w.shortened, wordCountBefore: w.originalWords, wordCountAfter: w.finalWords } : {}),
  });

  /**
   * One side's opening. Order between A and B is free (they do not read each other). If this side's opening is already in the
   * state the stored one is returned with reused:true and NO model request is made.
   */
  async function generateOpening(state: AiRoundState, side: Side, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OpeningStep> {
    if (side !== "A" && side !== "B") return { ok: false, state, error: err("wrong_turn", 'side must be "A" or "B"') };
    if (state.closed) return { ok: false, state, error: err("round_closed", "the round has been judged") };
    const existing = openingOf(state, side);
    if (existing) return { ok: true, state, argument: publicArgument(state, existing), reused: true };
    const r = await engine.generateOpening({ roundId: state.roundId, scenario: state.scenario, side, timeoutMs: opts.timeoutMs, signal: opts.signal });
    if (!r.ok) return { ok: false, state, error: fromModel(r.error) };
    const entry: TranscriptEntry = { stage: "opening", side, text: r.argument.text };
    const other = openingOf(state, side === "A" ? "B" : "A");
    const transcript = side === "A" ? [entry, ...(other ? [other] : []), ...state.transcript.filter((e) => e.stage === "turn")] : [...(other ? [other] : []), entry, ...state.transcript.filter((e) => e.stage === "turn")];
    const next: AiRoundState = { ...state, transcript, revision: state.revision + 1 };
    return { ok: true, state: next, argument: publicArgument(next, entry), reused: false, telemetry: telemetryOf(r.argument.meta, r.argument.wordLimit) };
  }

  /**
   * The next sequential turn (speaker alternates A, B, A, B ...; the first turn is sequence 3). `submissions` may be cumulative
   * or only new ones: ids already in the state are ignored. Everything passed BEFORE this call is eligible for THIS turn's request;
   * both sides' submissions are stored. `turn` (the sequence you believe you are requesting) makes repeats safe: an
   * already-generated turn is returned with reused:true and no model request. On failure the state is returned UNCHANGED and the
   * submissions of that call are not stored: send them again (sending the cumulative list every time is simplest).
   */
  async function nextTurn(
    state: AiRoundState,
    input: { submissions?: AudienceSubmission[]; turn?: number; speaker?: Side; timeoutMs?: number; maxWords?: number; signal?: AbortSignal } = {},
  ): Promise<TurnStep> {
    if (state.closed) return { ok: false, state, error: err("round_closed", "the round has been judged") };
    if (!openingOf(state, "A") || !openingOf(state, "B")) return { ok: false, state, error: err("not_ready", "both openings must exist before the first debate turn") };
    const done = turnsOf(state);
    const nextSequence = state.transcript.length + 1;
    if (input.turn !== undefined) {
      if (input.turn < nextSequence) {
        const prior = state.transcript.find((e) => e.stage === "turn" && e.turn === input.turn);
        if (!prior) return { ok: false, state, error: err("out_of_order", `sequence ${input.turn} is not a debate turn (openings are sequence 1 and 2; turns start at 3)`) };
        if (input.speaker && input.speaker !== prior.side) return { ok: false, state, error: err("wrong_turn", `turn ${input.turn} belongs to Agent ${prior.side}`) };
        return { ok: true, state, argument: publicArgument(state, prior), reused: true };
      }
      if (input.turn > nextSequence) return { ok: false, state, error: err("out_of_order", `the next turn is sequence ${nextSequence}, not ${input.turn}`) };
    }
    if (done >= state.maxTurns) return { ok: false, state, error: err("round_complete", `all ${state.maxTurns} turns are done: request the verdict`) };
    const speaker: Side = done % 2 === 0 ? "A" : "B";
    if (input.speaker && input.speaker !== speaker) return { ok: false, state, error: err("wrong_turn", `it is Agent ${speaker}'s turn (sequence ${nextSequence})`) };
    const other: Side = speaker === "A" ? "B" : "A";
    const subs = Array.isArray(input.submissions) ? input.submissions : [];
    // Both sides' messages are stored now (snapshot before any await); only the speaker's reach this request.
    const otherAudience = ingestSubmissions(state.audience[other], subs, config.injections.maxChars).state;
    const res = await engine.generateNextTurn({
      roundId: state.roundId,
      speaker,
      scenario: state.scenario,
      transcript: state.transcript,
      injections: subs,
      audienceThemeState: state.audience[speaker],
      maxWords: input.maxWords,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    if (!res.ok) return { ok: false, state, error: fromModel(res.error) };
    const entry: TranscriptEntry = { stage: "turn", side: speaker, text: res.argument.text, turn: res.turn };
    const next: AiRoundState = {
      ...state,
      transcript: [...state.transcript, entry],
      audience: { ...state.audience, [speaker]: res.audienceThemeState ?? state.audience[speaker], [other]: otherAudience } as Record<Side, AudienceThemeState>,
      revision: state.revision + 1,
    };
    return {
      ok: true,
      state: next,
      argument: publicArgument(next, entry),
      reused: false,
      telemetry: telemetryOf(res.argument.meta, res.argument.wordLimit),
      private: { audience: res.audience, analysis: res.audienceAnalysis, briefing: res.briefing, originalText: res.argument.wordLimit?.originalText },
    };
  }

  /**
   * The independent judge: ONE request, fed only the public scenario, the locked interpretations and the public transcript.
   * A debate that stopped early (deadline) is still judged as the engine allows (both openings required); `complete` says whether
   * all maxTurns were played. Already judged: the stored verdict is returned with reused:true and no model request.
   */
  async function judge(state: AiRoundState, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JudgeStep> {
    const turns = turnsOf(state);
    if (state.verdict) return { ok: true, state, verdict: state.verdict, complete: turns >= state.maxTurns, turnsCompleted: turns, reused: true };
    if (!openingOf(state, "A") || !openingOf(state, "B")) return { ok: false, state, error: err("not_ready", "both openings must exist before judging") };
    const r = await engine.judgeDebate({ roundId: state.roundId, scenario: state.scenario, transcript: state.transcript, timeoutMs: opts.timeoutMs, signal: opts.signal });
    if (!r.ok) return { ok: false, state, error: fromModel(r.error) };
    const next: AiRoundState = { ...state, verdict: r.verdict, closed: true, revision: state.revision + 1 };
    return { ok: true, state: next, verdict: r.verdict, complete: turns >= state.maxTurns, turnsCompleted: turns, reused: false, telemetry: { ...telemetryOf(r.meta), attempts: r.attempts } };
  }

  return { config, generateOpening, nextTurn, judge };
}
export type AiRound = ReturnType<typeof createAiRound>;
