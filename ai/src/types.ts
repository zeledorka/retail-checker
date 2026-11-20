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
export type DebateStage = "opening" | "rebuttal" | "closing";
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
  window: InjectionWindow;
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
};

export type StageInput = {
  roundId: string;
  scenario: Scenario;
  /** All public arguments published so far (any order). */
  transcript?: TranscriptEntry[];
  /** All audience submissions for the round; the engine filters by window and side. */
  injections?: AudienceInjection[];
  signal?: AbortSignal;
};

export type JudgeInput = {
  roundId: string;
  scenario: Scenario;
  transcript: TranscriptEntry[];
  signal?: AbortSignal;
};

export type ModelCallEvent = {
  roundId: string;
  role: "agentA" | "agentB" | "judge";
  stage: DebateStage | "verdict";
  outcome: GenerateOutcome;
};
