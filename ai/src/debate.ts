import { generateText as defaultGenerate } from "./providers";
import { selectInjections } from "./injections";
import { buildAgentPrompt, buildAgentSystem, buildJudgePrompt, JUDGE_SYSTEM, STAGE_ORDER } from "./prompts";
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
  Side,
  StageInput,
  StageResult,
  TranscriptEntry,
} from "./types";

export type EngineOptions = {
  /** Injected for tests; defaults to the real provider adapters. */
  generate?: GenerateTextFn;
  /** Called after every model call (success or failure) for logging/metrics. */
  onModelCall?: (event: ModelCallEvent) => void;
};

const SIDES: Side[] = ["A", "B"];
const WINDOW: Record<DebateStage, 1 | 2 | null> = { opening: null, rebuttal: 1, closing: 2 };

export const argumentKey = (roundId: string, stage: DebateStage, side: Side) => `${roundId}:${stage}:${side}`;
export const verdictKey = (roundId: string) => `${roundId}:verdict`;

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

  async function runStage(stage: DebateStage, input: StageInput): Promise<StageResult> {
    const { roundId, scenario, signal } = input;
    // Only arguments from earlier stages are visible: both agents share the same snapshot.
    const history = (input.transcript ?? []).filter((e) => STAGE_ORDER.indexOf(e.stage) < STAGE_ORDER.indexOf(stage));
    const missing = missingHistory(STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage)), history);
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
          system: buildAgentSystem(side, scenario, config.argumentMaxWords),
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

  async function judgeDebate(input: JudgeInput): Promise<JudgeResult> {
    const { roundId, scenario, signal } = input;
    const key = verdictKey(roundId);
    // Only public arguments reach the judge: no injections, bets, balances or player data.
    const transcript: TranscriptEntry[] = input.transcript.map(({ stage, side, text }) => ({ stage, side, text }));
    const missing = missingHistory(STAGE_ORDER, transcript);
    if (missing) return { ok: false, roundId, key, attempts: 0, error: { kind: "missing_history", message: missing, retryable: false } };

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
    generateOpeningArguments: (input: StageInput) => runStage("opening", input),
    generateRebuttals: (input: StageInput) => runStage("rebuttal", input),
    generateClosingArguments: (input: StageInput) => runStage("closing", input),
    judgeDebate,
  };
}

export type DebateEngine = ReturnType<typeof createDebateEngine>;
