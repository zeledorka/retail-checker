import { generateText as defaultGenerate } from "./providers";
import { selectInjections } from "./injections";
import { buildAgentPrompt, buildAgentSystem, buildJudgePrompt, buildTurnPrompt, JUDGE_SYSTEM, STAGE_ORDER } from "./prompts";
import { parseVerdict } from "./judge";
import type {
  ArgumentOutput,
  DebateStage,
  EngineConfig,
  GenerateTextFn,
  JudgeInput,
  JudgeResult,
  ModelCallEvent,
  ModelError,
  NextTurnInput,
  Side,
  StageInput,
  StageResult,
  TranscriptEntry,
  TurnResult,
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
          system: buildAgentSystem(side, scenario, config.argumentMaxWords, input.personas?.[side]),
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
      const { text, ...meta } = outcome.result;
      args[side] = {
        roundId,
        stage,
        side,
        text,
        key: argumentKey(roundId, stage, side),
        injectionIdsUsed: selected.map((s) => s.id),
        meta,
      };
    }
    if (args.A && args.B) return { ok: true, roundId, stage, arguments: { A: args.A, B: args.B } };
    return { ok: false, roundId, stage, arguments: args, errors };
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

    const selected = selectInjections(input.injections, speaker, undefined, config.injections, new Set(input.consumedInjectionIds ?? []));
    const requested = input.maxWords ?? config.turnMaxWords ?? DEFAULT_TURN_WORDS;
    const maxWords = Number.isFinite(requested) ? Math.max(10, Math.min(150, Math.floor(requested))) : DEFAULT_TURN_WORDS;
    const base = speaker === "A" ? config.agentA : config.agentB;
    const modelCfg = input.timeoutMs && input.timeoutMs > 0 ? { ...base, timeoutMs: Math.min(base.timeoutMs, input.timeoutMs) } : base;

    const outcome = await generate(modelCfg, {
      system: buildAgentSystem(speaker, scenario, maxWords, input.personas?.[speaker], Math.min(35, Math.floor(maxWords * 0.8))),
      prompt: buildTurnPrompt(speaker, scenario, history, selected, turn),
      signal,
    });
    notify({ roundId, role: speaker === "A" ? "agentA" : "agentB", stage: "turn", outcome });
    if (!outcome.ok) return fail(outcome.error);

    const { text, ...meta } = outcome.result;
    return {
      ok: true,
      roundId,
      turn,
      argument: {
        roundId,
        stage: "turn",
        turn,
        side: speaker,
        text,
        key: turnKey(roundId, turn, speaker),
        injectionIdsUsed: selected.map((s) => s.id),
        meta,
      },
    };
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
    const maxAttempts = 1 + Math.max(0, config.judgeParseRetries);
    let lastError: ModelError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await generate(config.judge, request);
      notify({ roundId, role: "judge", stage: "verdict", outcome });
      if (!outcome.ok) return { ok: false, roundId, key, attempts: attempt, error: outcome.error };
      const parsed = parseVerdict(outcome.result.text);
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
    generateOpeningArguments: (input: StageInput) => runStage("opening", input),
    generateRebuttals: (input: StageInput) => runStage("rebuttal", input),
    generateClosingArguments: (input: StageInput) => runStage("closing", input),
    judgeDebate,
  };
}

export type DebateEngine = ReturnType<typeof createDebateEngine>;
