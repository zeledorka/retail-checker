// Public contracts for the AI Courtroom debate engine.
// Other modules (game backend, UI) should depend only on these types and src/index.ts.

export type Provider = "anthropic" | "openrouter";
export type Effort = "low" | "medium" | "high";

export type ModelConfig = {
  provider: Provider;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Retries for transient errors only (429, 5xx, connection, timeout). Handled by the provider SDK. */
  maxRetries: number;
  /** Anthropic only: sent as output_config.effort when set. Ignored for OpenRouter. */
  effort?: Effort;
  /** OpenRouter only (Anthropic ignores it: newer Claude models reject non-default sampling). Omitted = provider default. */
  temperature?: number;
  /** OpenRouter only: sent as reasoning.effort. "none" is rejected by models that mandate reasoning (no silent fallback). */
  reasoning?: "none" | "minimal" | "low" | "medium" | "high";
  /** OpenRouter only: sent as provider.sort to pick the fastest endpoint of the SAME model. */
  routeSort?: "latency" | "throughput" | "price";
};

export type GenerateRequest = {
  system: string;
  prompt: string;
  signal?: AbortSignal;
};

export type ModelResult = {
  text: string;
  provider: Provider;
  /** Model reported by the provider response (falls back to the requested id). */
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Hidden reasoning tokens when the provider reports them (included in outputTokens). */
  reasoningTokens?: number;
};

export type ModelErrorKind =
  | "config"
  | "timeout"
  | "aborted"
  | "rate_limit"
  | "auth"
  | "bad_request"
  | "provider_error"
  | "connection"
  | "refusal"
  | "empty_output"
  | "truncated"
  | "invalid_output"
  | "missing_history";

export type ModelError = {
  kind: ModelErrorKind;
  message: string;
  provider?: Provider;
  model?: string;
  status?: number;
  retryable: boolean;
  latencyMs?: number;
};

export type GenerateOutcome = { ok: true; result: ModelResult } | { ok: false; error: ModelError };
export type GenerateTextFn = (config: ModelConfig, request: GenerateRequest) => Promise<GenerateOutcome>;

// ---- Debate domain ----

export type Side = "A" | "B";
/** "turn" = one sequential argument produced by generateNextTurn(). */
export type DebateStage = "opening" | "rebuttal" | "closing" | "turn";
export type InjectionWindow = 1 | 2;

export type Scenario = {
  title: string;
  description: string;
  evidence: string[];
  interpretationA: string;
  interpretationB: string;
};

/** Raw audience submission as stored by the game backend. Untrusted. */
export type AudienceInjection = {
  id: string;
  side: Side;
  /** Only used by the fixed-stage APIs (rebuttal = 1, closing = 2). Ignored by generateNextTurn(). */
  window?: InjectionWindow;
  text: string;
  /** ISO string or epoch ms; used for deterministic ordering. */
  submittedAt: string | number;
  playerId?: string;
};

/** One published (public) argument. The judge sees only these. */
export type TranscriptEntry = {
  stage: DebateStage;
  side: Side;
  text: string;
  /** 1-based position in the debate. Set on generateNextTurn() output; store it and send it back so order is unambiguous. */
  turn?: number;
};

export type ArgumentOutput = TranscriptEntry & {
  roundId: string;
  /** Stable idempotency key: `${roundId}:${stage}:${side}`. Persist with a unique constraint. */
  key: string;
  injectionIdsUsed: string[];
  meta: Omit<ModelResult, "text">;
};

export type StageResult =
  | { ok: true; roundId: string; stage: DebateStage; arguments: Record<Side, ArgumentOutput> }
  | {
      ok: false;
      roundId: string;
      stage: DebateStage;
      /** Arguments that did succeed (not published by the engine; backend decides). */
      arguments: Partial<Record<Side, ArgumentOutput>>;
      errors: Partial<Record<Side, ModelError>>;
    };

export type CriterionScores = { evidence: number; logic: number; rebuttal: number; persuasion: number };

export type JudgeVerdict = {
  winner: Side;
  explanation: string;
  scores: Record<Side, CriterionScores>;
};

export type JudgeResult =
  | { ok: true; roundId: string; key: string; verdict: JudgeVerdict; meta: Omit<ModelResult, "text">; attempts: number }
  | { ok: false; roundId: string; key: string; error: ModelError; attempts: number };

// ---- Engine configuration ----

export type InjectionLimits = {
  maxPerAgent: number;
  maxChars: number;
};

export type EngineConfig = {
  agentA: ModelConfig;
  agentB: ModelConfig;
  judge: ModelConfig;
  argumentMaxWords: number;
  injections: InjectionLimits;
  /** Extra judge attempts when the output is not valid JSON. */
  judgeParseRetries: number;
  /** Word cap for generateNextTurn() when the call gives none. Default 45. */
  turnMaxWords?: number;
};

export type StageInput = {
  roundId: string;
  scenario: Scenario;
  /** All public arguments published so far (any order). */
  transcript?: TranscriptEntry[];
  /** All audience submissions for the round; the engine filters by window and side. */
  injections?: AudienceInjection[];
  /** Optional reasoning-style text per side (trusted app config, not audience input). Never changes the side defended. */
  personas?: Partial<Record<Side, string>>;
  signal?: AbortSignal;
};

export type JudgeInput = {
  roundId: string;
  scenario: Scenario;
  transcript: TranscriptEntry[];
  signal?: AbortSignal;
};

export type NextTurnInput = {
  roundId: string;
  speaker: Side;
  scenario: Scenario;
  /** Completed public transcript so far (any stage mix). The turn number is transcript.length + 1. */
  transcript?: TranscriptEntry[];
  /** Everything currently eligible for the speaker (either side; the engine filters). Snapshot at call time. */
  injections?: AudienceInjection[];
  /** IDs already shown to an agent in earlier turns; never selected again. */
  consumedInjectionIds?: Iterable<string>;
  personas?: Partial<Record<Side, string>>;
  /** Word cap for this turn (default config.turnMaxWords ?? 45). Prompted, never enforced by truncation. */
  maxWords?: number;
  /** Upper bound for this request's timeout (the model config's own timeout still applies if smaller). */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type TurnResult =
  | { ok: true; roundId: string; turn: number; argument: ArgumentOutput }
  | { ok: false; roundId: string; turn: number; speaker: Side; error: ModelError };

export type ModelCallEvent = {
  roundId: string;
  role: "agentA" | "agentB" | "judge";
  stage: DebateStage | "verdict";
  outcome: GenerateOutcome;
};
