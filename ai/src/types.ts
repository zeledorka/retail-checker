// Public contracts for the AI Courtroom debate engine.
// Other modules (game backend, UI) should depend only on these types and src/index.ts.
import type { WordLimitInfo } from "./wordlimit";

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
  /**
   * Anthropic only. "disabled" sends thinking:{type:"disabled"}, which frees the whole output budget for the visible reply.
   * Accepted by Claude Haiku 5.5 at effort high or below; Sonnet 5.5 rejects it (400, reported as bad_request). Unset = model default.
   */
  thinking?: "disabled";
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
  /** The reply was cut at maxOutputTokens and the engine kept a complete, readable part of it. */
  truncated?: boolean;
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
  /** Usage the provider reported for a request that still consumed tokens (truncated, refused, empty). */
  inputTokens?: number;
  outputTokens?: number;
  /** For `truncated`: the visible text received before the cap. Only a complete part of it may ever be used. */
  partialText?: string;
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
  /** How the public text was bounded. `text` is ALWAYS the final bounded text: publish, store and judge exactly this. */
  wordLimit?: WordLimitInfo;
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

/** A judge reference to one public transcript entry (ids E1, E2, ... follow chronological order in the judge prompt). */
export type JudgeReference = { ref: string; side: Side; note: string; quote?: string };

export type JudgeVerdict = {
  winner: Side;
  explanation: string;
  /** Each dimension 0-10. Winner rule: higher total; tie -> higher rebuttal, then higher evidence. */
  scores: Record<Side, CriterionScores>;
  /** Computed by the engine (mean of the four dimensions, one decimal), never taken from the model. */
  overall?: Record<Side, number>;
  /** One short sentence for a small display. */
  summary?: string;
  strengths?: Record<Side, string[]>;
  weaknesses?: Record<Side, string[]>;
  /** Only references that exist in the transcript, match the speaker and (when quoted) quote the entry. */
  references?: JudgeReference[];
  unsupportedAssumptions?: { side: Side; ref?: string; assumption: string }[];
  decisiveExchange?: { refs: string[]; description: string };
  validation?: { rejectedReferences: { ref: string; reason: string }[] };
};

export type JudgeResult =
  | { ok: true; roundId: string; key: string; verdict: JudgeVerdict; meta: Omit<ModelResult, "text">; attempts: number }
  | { ok: false; roundId: string; key: string; error: ModelError; attempts: number };

// ---- Engine configuration ----

export type InjectionLimits = {
  /** Fixed-stage APIs only (rebuttal / closing): max submissions per agent. */
  maxPerAgent: number;
  /** Max characters kept from any single submission (longer text is cut with an ellipsis). */
  maxChars: number;
  /** generateNextTurn(): total audience-text budget per turn in characters. Default 10000. */
  batchChars?: number;
  /** generateNextTurn(): hard cap on messages per turn, a safety net on top of the character budget. Default 200. */
  batchMaxMessages?: number;
  /** generateNextTurn(): max messages one player can have in a single turn's batch (the rest queue). Default 2. */
  maxPerPlayer?: number;
};

/**
 * A group of submissions with identical wording (case, punctuation and spacing ignored). Only exact wording is grouped
 * here: related ideas worded differently stay separate themes and are left to the model's judgement.
 */
export type AudienceTheme = {
  /** The oldest submission with this wording; it is the one sent to the model. */
  representativeId: string;
  text: string;
  /** Distinct players (by playerId) who sent this wording in this snapshot. A player counts once however often they repeat it. */
  supporters: number;
  /** All submissions with this wording in this snapshot (repeats included). */
  messages: number;
  /** Submissions without a playerId: their independence cannot be established, so they are not in `supporters`. */
  anonymous: number;
};

/** What happened to every submission the backend sent for one turn. The backend marks `processedIds` as consumed. */
export type AudienceReport = {
  /** Sent to the model, oldest first (equals argument.injectionIdsUsed). */
  includedIds: string[];
  /** Eligible but not sent this turn (budget, message cap or per-player cap). Keep them pending for the next turn. */
  queuedIds: string[];
  /** Exact-text repeats of an included message: covered by it, nothing more to send. */
  duplicateIds: string[];
  /** Unusable for this side (blank after sanitising). */
  invalidIds: string[];
  /** includedIds + duplicateIds + invalidIds: add these to consumedInjectionIds. */
  processedIds: string[];
  /** Theme mode: later submissions from a player who already counted; kept in the state, never counted or shown. */
  ignoredIds?: string[];
  /** Themes sent to the model this turn, most supported first. Counts cover only the snapshot of this call. */
  themes: AudienceTheme[];
  stats: {
    received: number; // everything in the snapshot, both sides
    otherSide: number;
    alreadyConsumed: number; // this side, in consumedInjectionIds
    forSpeaker: number; // = included + queued + duplicates + invalid
    included: number;
    queued: number;
    duplicates: number;
    invalid: number;
    /** included + duplicates: submissions whose content reached the model, directly or through an identical copy. */
    represented: number;
    /** Theme mode: submissions newly absorbed by this call. */
    absorbed?: number;
    /** Theme mode: submissions ignored as extra submissions of an already-counted player (cumulative). */
    ignored?: number;
    /** Distinct wordings among this side's eligible submissions, and how many of them were sent. */
    themes: number;
    themesIncluded: number;
    chars: number; // audience text characters sent to the model
    processingMs: number;
    /** Age of the oldest queued submission, when its timestamp is parseable. */
    oldestQueuedAgeMs?: number;
  };
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
  /** Hard cap on every public argument (openings and turns), enforced in code after the model replies. Default 45. */
  publicWordLimit?: number;
  /** Explicitly configured model for semantic theme reconciliation (no default; without it only exact grouping runs). */
  reconciler?: ModelConfig;
  /** Why semantic grouping is or is not active (set by loadEngineConfig). */
  themesStatus?: ThemesStatus;
  themes?: ThemeLimits;
};

export type ThemesStatus = {
  state: "enabled" | "disabled" | "unavailable";
  /** default = reused an existing Claude role; override = THEMES_PROVIDER / THEMES_MODEL. */
  source: "default" | "override" | "none";
  provider?: Provider;
  model?: string;
  reason?: string;
};

export type ThemeLimits = {
  /** Themes shown to an agent per turn (default 200, enough for ~200 participants; the state keeps all of them). */
  briefingThemes?: number;
  /** Characters of suggestion text in one briefing (default 20000). */
  briefingChars?: number;
  /** Unreviewed themes compared per reconciliation request (default 40). */
  maxNewPerRequest?: number;
  /** Already-reviewed themes included as merge targets per request (default 30). */
  maxExistingPerRequest?: number;
  /** Model requests per reconcileAudienceThemes() call (default 2). */
  maxRequests?: number;
  /** Wall-clock cap for one reconcileAudienceThemes() call (default 20000 ms). */
  deadlineMs?: number;
};

/** One persistent audience theme. All fields are plain JSON. Counts are unions over everything ever ingested. */
export type ThemeRecord = {
  /** Stable: assigned once ("t1", "t2", ...) and kept by the surviving theme when themes merge. */
  id: string;
  seq: number;
  /** Representative wording (that of the best-supported member). */
  suggestion: string;
  /** Normalised exact wordings that belong to this theme (see themeKey). */
  keys: string[];
  /** Distinct supporting players. cumulative supporters = players.length. */
  players: string[];
  /** Submissions without a playerId: counted in `messages` only. */
  anonymous: number;
  messages: number;
  firstAt: number;
  latestAt: number;
  /** Every source submission ID absorbed into this theme. */
  sourceIds: string[];
  /** Players already counted the last time this theme was briefed to the agent (newSupporters = players - briefedPlayers). */
  briefedPlayers: string[];
  /** Turns in which the theme was shown to the agent. Whether it was then argued is NOT known to the engine. */
  briefedTurns: number[];
  /** Semantic reconciliation has compared it with the other themes (merged or deliberately kept apart). */
  reviewed: boolean;
  attempts: number;
  mergedFrom: string[];
};

export type AudienceThemeState = {
  version: 1;
  roundId: string;
  side: Side;
  nextSeq: number;
  reconcileRuns: number;
  themes: ThemeRecord[];
  /** Blank-after-sanitising submissions (consumed, never shown). */
  invalidIds: string[];
  /**
   * Further submissions from a player who already has one counted (the backend allows one per player per round).
   * Original text and ID are kept here; they never add support and are not shown to the agent.
   */
  extras: { id: string; playerId: string; text: string; at: number }[];
  /** Newest last; bounded to the latest 200 entries. */
  mergeLog: { into: string; from: string[]; run: number }[];
};

export type ThemeBriefingItem = {
  id: string;
  suggestion: string;
  supporters: number;
  newSupporters: number;
  briefedBefore?: true;
  /** Not yet compared with the other themes: it may be a rewording of another one. */
  grouping?: "pending";
};
/** Result of validating the agent's own grouping of the briefing (counts are computed here, never taken from the model). */
export type AudienceGroup = {
  label: string;
  /** Wording ids (themes) from the briefing that the agent assigned to this idea. */
  sourceWordingIds: string[];
  /** Distinct players behind those wordings (union, computed by the engine). */
  supporters: number;
  messages: number;
  /** supporters / distinct players across the whole briefing. */
  share: number;
  relevance: "high" | "medium" | "low" | "none";
  /** The agent's SELF-REPORT that its argument used the idea. Not verified. */
  usedInArgument: boolean;
  /** new: no wording was briefed before | growing: gained supporters since the last briefing | existing: nothing new. */
  status: "new" | "growing" | "existing";
  /** Present only when the model claimed a count that differs from the computed one. */
  claimedSupporters?: number;
  /** Wordings the model put in this group but that were QUARANTINED (ambiguous or conflicting): not counted in `supporters`. */
  quarantinedWordingIds?: string[];
};

/** What happened to one briefed wording in the validation. Exactly one outcome per wording id, never silently dropped. */
export type WordingOutcome =
  | "assigned" // in exactly one validated relevant group; counts as support there
  | "unsafe" // classified irrelevant / fabricated / adversarial (unassigned, or in a group the agent rated relevance "none")
  | "unassigned" // set aside as unclear: no group, not counted as support
  | "quarantined" // ambiguous (several groups, or group AND unassigned): counted nowhere
  | "missing"; // the agent did not account for it

export type AudienceAccounting = {
  briefedWordings: number;
  /** Distinct players behind all briefed wordings. */
  briefedPlayers: number;
  /** Each bucket: wordings and DISTINCT players (sets of player ids, never summed across groups). */
  validated: { wordings: number; players: number };
  unsafe: { wordings: number; players: number };
  unassigned: { wordings: number; players: number };
  quarantined: { wordings: number; players: number };
  missing: { wordings: number; players: number };
  /** Ids the model invented (not in the briefing): they never count and are not part of any bucket. */
  unknownIds: number;
  /** wordings across the five buckets = briefedWordings. */
  balanced: boolean;
};

export type AudienceAnalysis = {
  /** false when the metadata was missing or malformed; the public argument is still returned. */
  valid: boolean;
  /** true when every briefed wording got a clean outcome (no quarantine, no missing, no unknown or malformed part). */
  clean: boolean;
  /** Validated relevant groups only: support counts exclude quarantined, unsafe, unassigned and missing wordings. */
  groups: AudienceGroup[];
  /** Groups the agent rated relevance "none": excluded from support, kept visible. */
  excludedGroups: { label: string; sourceWordingIds: string[]; supporters: number }[];
  /** Unsafe or unclear wordings the agent set aside (reason: irrelevant | fabricated | adversarial | unclear). */
  unassigned: { wordingId: string; reason: string; supporters: number }[];
  /** Wordings with a conflicting or ambiguous classification: kept in state, counted nowhere. */
  quarantined: { wordingId: string; issue: string; supporters: number }[];
  /** Briefed wordings the agent did not mention at all. */
  unmentionedWordingIds: string[];
  /** Everything rejected or flagged in the model output. */
  rejected: { kind: "unknown_id" | "overlap" | "conflict" | "claimed_count" | "malformed" | "repeated_player" | "unrecognised" | "irrelevant_group" | "missing"; detail: string }[];
  outcomes: Record<string, WordingOutcome>;
  accounting: AudienceAccounting;
  /** Compatibility totals: groupedPlayers / groupedWordings count VALIDATED support only. */
  totals: { briefedWordings: number; briefedPlayers: number; groupedPlayers: number; groupedWordings: number };
  parseMs: number;
};

export type ThemeBriefing = {
  themes: ThemeBriefingItem[];
  /** Themes left out of this prompt by the budget (they stay in the state). */
  omitted: number;
  totalThemes: number;
  /** Source submission IDs behind the themes in this prompt / behind the omitted themes. */
  representedIds: string[];
  omittedIds: string[];
  /** Characters of suggestion text in the prompt. */
  chars: number;
};

/** What a reconciliation changed. Apply it to the LATEST stored state with applyThemeDelta() (idempotent). */
export type ThemeDelta = { merges: { into: string; from: string[] }[]; reviewed: string[]; failed: string[] };

export type ReconcileInput = {
  roundId: string;
  side: Side;
  scenario: Scenario;
  previousState?: AudienceThemeState;
  newSubmissions?: AudienceInjection[];
  consumedInjectionIds?: Iterable<string>;
  signal?: AbortSignal;
};
export type ReconcileReport = {
  /**
   * complete: nothing left unreviewed (no request is made when there is nothing to review) | partial: bounded, more remain |
   * failed: a request failed, themes stay pending | unavailable: no usable provider/key | disabled: THEMES_ENABLED=false.
   * In every non-complete case all submissions stay counted in their (exact-wording) themes.
   */
  status: "complete" | "partial" | "failed" | "unavailable" | "disabled";
  reason?: string;
  requests: number;
  failedRequests: number;
  durationMs: number;
  merges: { into: string; from: string[] }[];
  /** Unreviewed themes (still counted and briefed as separate themes). */
  pendingThemeIds: string[];
  ingest: { received: number; absorbed: number; alreadyKnown: number; otherSide: number; alreadyConsumed: number; invalid: number; newThemes: number };
  errors: ModelError[];
};
export type ReconcileResult = { state: AudienceThemeState; delta: ThemeDelta; report: ReconcileReport };

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
  /** Upper bound for each judge request's timeout (the judge model config's own timeout still applies if smaller). */
  timeoutMs?: number;
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
  /**
   * Persistent theme mode. When given (and its roundId/side match the speaker), `injections` are ingested into this
   * state (already-known IDs are ignored, so the whole list may be passed every time) and the agent receives a
   * bounded briefing of the speaker's cumulative themes instead of the per-turn batch. The updated state comes back
   * in the result. Without it the stateless batching of earlier versions is used.
   */
  audienceThemeState?: AudienceThemeState;
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
  | {
      ok: true;
      roundId: string;
      turn: number;
      argument: ArgumentOutput;
      /** Theme mode: every valid new submission is `includedIds` (absorbed into a theme); nothing is queued. */
      audience: AudienceReport;
      /** Theme mode only: store this and pass it back next turn. */
      audienceThemeState?: AudienceThemeState;
      briefing?: ThemeBriefing;
      /**
       * PRIVATE audit of how the agent grouped this side's briefing, from the same request as the argument. Never publish
       * it or send it to the opponent or the judge. `usedInArgument` is the agent's self-report.
       */
      audienceAnalysis?: AudienceAnalysis;
    }
  | { ok: false; roundId: string; turn: number; speaker: Side; error: ModelError };

export type ModelCallEvent = {
  roundId: string;
  role: "agentA" | "agentB" | "judge" | "themes";
  stage: DebateStage | "verdict" | "reconcile";
  outcome: GenerateOutcome;
};
