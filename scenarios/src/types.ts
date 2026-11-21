// Types for the pre-round preparation pipeline. Server-side only: nothing here is sent to the judge or the public frontend
// unless a field is explicitly listed in `PublicScenario`.
import type { Scenario } from "../../ai/src/index";

export type Side = "A" | "B";

/** One candidate reading of the case. `id` is a stable slug (unique within its case), kept in all metadata. */
export type Interpretation = { id: string; label: string; description: string };

/** A prepared case: an ambiguous situation, public evidence and 3-4 meaningfully different candidate interpretations. */
export type ScenarioCase = {
  /** Unique scenario id (slug). */
  id: string;
  title: string;
  description: string;
  /** 3-6 public observations. They support several interpretations and settle none. */
  evidence: string[];
  interpretations: Interpretation[];
  /** Prompt for an image generator (the image itself is generated separately and never during a debate). */
  imagePrompt: string;
  /** Optional path/URL of the generated image, relative to the site root (e.g. "/scenarios/empty-display-case.png"). */
  imagePath?: string;
};

/** Bounded, continuous traits (0..1). They shape ranking and argument STYLE; they never license invented facts. */
export type Personality = {
  seed: number;
  side: Side;
  /** How much proof a claim needs before the agent finds it defensible. */
  evidenceScepticism: number;
  /** How readily it draws inferences beyond what is directly observed. */
  inferenceWillingness: number;
  /** Comfort with a bold reading that could turn out wrong. */
  riskTolerance: number;
  /** Preference for a simple explanation over one with many moving parts. */
  simplicityPreference: number;
  /** Argumentative style dimensions. */
  directness: number;
  rhetoricalFlourish: number;
  rebuttalAggression: number;
};

/** What a ranker returns for one agent, before validation. */
export type RawRankingItem = { id: string; rank: number; defensibility: number; explanation: string };

/** A validated ranking item. `defensibility` is a model SELF-ASSESSMENT on 0-100, not a calibrated probability. */
export type RankingItem = RawRankingItem;

export type RankerError = { code: "model_error" | "invalid_output" | "config"; message: string; retryable: boolean };
export type RankerResult = { ok: true; rankings: RawRankingItem[]; telemetry?: { model?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number } } | { ok: false; error: RankerError };

/** What one agent's ranking request contains: the shared case, the shared candidates and ONLY that agent's own personality. */
export type OpinionRequest = {
  side: Side;
  scenario: { title: string; description: string; evidence: string[] };
  candidates: Interpretation[];
  personality: Personality;
};
export interface OpinionRanker {
  rank(request: OpinionRequest): Promise<RankerResult>;
}

export type SelectionOptions = {
  /** Minimum defensibility (0-100) for an opinion to be usable. Default 45 (see selector.ts). */
  minStrength?: number;
  /** Bonus added to a pair's score by the rank of each chosen opinion. Default [10, 3, 0] (modest preference for first choices). */
  rankBonus?: number[];
  /** Pairs scoring within this many points of the best are treated as tied and one is drawn with the seeded generator. Default 2. */
  tieMargin?: number;
  seed: number;
};

export type PairScore = { a: string; b: string; score: number; rankA: number; rankB: number; defensibilityA: number; defensibilityB: number };

export type SelectionDiagnostics = {
  minStrength: number;
  opinionsA: number;
  opinionsB: number;
  /** After removing opinions below minStrength. */
  usableA: number;
  usableB: number;
  pairsConsidered: number;
  pairsSameInterpretation: number;
  pairsBelowStrength: number;
  pairsValid: number;
  bestScore?: number;
  tiedPairs: number;
  topPairs: PairScore[];
};

export type SelectionFailure = { ok: false; reason: "invalid_ranking" | "no_credible_opposing_pair"; side?: Side; errors: string[]; diagnostics?: SelectionDiagnostics };
export type SelectionSuccess = { ok: true; a: Interpretation; b: Interpretation; chosen: PairScore; diagnostics: SelectionDiagnostics };
export type SelectionResult = SelectionSuccess | SelectionFailure;

/** SERVER-SIDE metadata of one preparation. Keep it with the round; never send it to the judge or the frontend. */
export type PreRoundMetadata = {
  scenarioId: string;
  seed: number;
  personalities: Record<Side, Personality>;
  candidates: Interpretation[];
  rankings: Record<Side, RawRankingItem[]>;
  selection: SelectionSuccess;
  /** Locked interpretation ids: A defends `A`, B defends `B`. */
  locked: Record<Side, string>;
  rankingTelemetry: Record<Side, { model?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number } | undefined>;
};

/** Shown to players: the same fields the AI round receives, plus the image. No personality, ranking or candidate list. */
export type PublicScenario = { title: string; description: string; evidence: string[]; interpretationA: string; interpretationB: string; imagePath?: string };

export type PrepareFailure = { ok: false; stage: "scenario" | "ranking" | "selection"; scenarioId: string; message: string; selection?: SelectionFailure; rankingError?: RankerError };
export type PrepareSuccess = {
  ok: true;
  /** Exactly the input of `startRound({ roundId, scenario })` in ai/src/round.ts. */
  scenario: Scenario;
  publicScenario: PublicScenario;
  meta: PreRoundMetadata;
};
export type PrepareResult = PrepareSuccess | PrepareFailure;
