// Types of the independent-opinion pipeline (replaces "rank four pre-written interpretations"). Server-side unless noted.
import type { Personality, Side } from "./types";
import type { Scenario } from "../../ai/src/index";

export type EvidenceItem = { id: string; text: string };

/** What every agent and the checker see: the case and its numbered public evidence. NO interpretations. */
export type ScenarioInput = { id: string; title: string; description: string; evidence: EvidenceItem[]; imagePrompt?: string; imagePath?: string };

/** One opinion as returned by an agent, before the system assigns its id. `selfDefensibility` is a self-assessment of argument strength, not a probability of truth. */
export type RawOpinion = { title: string; explanation: string; supportingEvidenceIds: string[]; weaknesses: string; rank: number; selfDefensibility: number };
export type GeneratedOpinion = RawOpinion & { id: string; side: Side };

export type StageError = { code: "model_error" | "invalid_output" | "insufficient_diversity" | "config"; message: string; retryable: boolean; details?: string[]; /** the model's raw reply when it could not be validated (server-side diagnostics only) */ raw?: string };
export type CallTelemetry = { model?: string; latencyMs?: number; inputTokens?: number; outputTokens?: number };

export type GenerationRequest = { side: Side; scenario: ScenarioInput; personality: Personality };
export type GenerationResult = { ok: true; opinions: GeneratedOpinion[]; telemetry?: CallTelemetry } | { ok: false; error: StageError };
export interface OpinionGenerator {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

/** What the checker sees of an opinion: anonymous id, content only. No side, personality, rank or self-score. */
export type CheckerOpinion = { id: string; title: string; explanation: string; supportingEvidenceIds: string[]; weaknesses: string };
/** ok = plausible; speculative = plausible but rests on unverified assumptions (eligible); unsupported = legacy flag, eligible with a small penalty; contradicted / implausible = ineligible whatever the score. */
export type CheckerFlag = "ok" | "speculative" | "unsupported" | "contradicted" | "implausible";
export type CheckerAssessment = { id: string; defensibility: number; flag: CheckerFlag; note: string };
export type PairJudgement = { a: string; b: string; difference: number; meaningful: boolean };
export type CheckerReport = { assessments: CheckerAssessment[]; equivalenceGroups: string[][]; pairs: PairJudgement[]; /** harmless structural repairs made locally (e.g. a dropped empty placeholder entry); never a changed judgment */ normalisations?: string[] };
export type CheckResult = { ok: true; report: CheckerReport; telemetry?: CallTelemetry } | { ok: false; error: StageError };
export interface OpinionChecker {
  check(request: { scenario: ScenarioInput; opinions: CheckerOpinion[] }): Promise<CheckResult>;
}

export type FinalSelectionOptions = {
  seed: number;
  /** Opinions the checker scores below this (0-100) are not usable. Default 30 (speculative but arguable is enough). */
  minDefensibility?: number;
  /** A pair whose causal explanations differ by less than this (checker's 0-100) is only a cosmetic disagreement. Default 40. */
  minDifference?: number;
  /** Largest allowed gap between the two sides' checker scores (an overwhelmingly weak side is never forced). Default 30. */
  maxBalanceGap?: number;
  /** Modest bonus by the generating agent's own rank 1/2/3. Default [6, 3, 0]. */
  rankBonus?: number[];
  /** Pairs within this many points of the best are tied and drawn with the seed. Default 2. */
  tieMargin?: number;
};

export type PairRejection = "contradicted_or_weak" | "same_explanation" | "cosmetic_difference" | "unbalanced";
export type OpinionPair = { a: string; b: string; score: number; defensibilityA: number; defensibilityB: number; difference: number; rankA: number; rankB: number };
export type OpinionSelectionDiagnostics = {
  pairsConsidered: number;
  rejected: Record<PairRejection, number>;
  usableA: number;
  usableB: number;
  pairsValid: number;
  bestScore?: number;
  tiedPairs: number;
  topPairs: OpinionPair[];
  /** every opinion with the checker's verdict and whether the selector could use it */
  opinions: { id: string; anonId?: string; defensibility?: number; flag?: string; usable: boolean; reason?: string }[];
  /** the outcome for each of the nine A-B pairs */
  pairStatus: { a: string; b: string; status: "valid" | PairRejection }[];
  options: Required<Omit<FinalSelectionOptions, "seed">> & { seed: number };
};
export type OpinionSelectionResult =
  | { ok: true; a: GeneratedOpinion; b: GeneratedOpinion; chosen: OpinionPair; diagnostics: OpinionSelectionDiagnostics }
  | { ok: false; reason: "no_credible_opposing_pair"; message: string; diagnostics: OpinionSelectionDiagnostics };

/** What was produced before a failure, for server-side diagnosis. Present whenever the stage got that far. */
export type PartialMeta = { seed: number; personalities: Record<Side, Personality>; generated?: Record<Side, GeneratedOpinion[]>; checkerOrder?: { opinionId: string; anonId: string }[]; checkerReport?: CheckerReport };
export type OpinionPrepareFailure = { ok: false; stage: "input" | "generation" | "checker" | "selection"; scenarioId: string; message: string; error?: StageError; selection?: Extract<OpinionSelectionResult, { ok: false }>; partial?: PartialMeta; llmCalls: number };
export type OpinionPrepareSuccess = {
  ok: true;
  /** Exactly the input of `startRound({ roundId, scenario })` in ai/src/round.ts. */
  scenario: Scenario;
  /** Safe for the frontend: no personalities, no unselected opinions, no diagnostics. */
  publicScenario: { title: string; description: string; evidence: string[]; interpretationA: string; interpretationB: string; imagePath?: string };
  /** SERVER-ONLY. Never give it to the judge, the debating agents or the browser. */
  meta: {
    scenarioId: string;
    seed: number;
    personalities: Record<Side, Personality>;
    generated: Record<Side, GeneratedOpinion[]>;
    /** opinion id -> anonymous id shown to the checker, in the order shown. */
    checkerOrder: { opinionId: string; anonId: string }[];
    checkerReport: CheckerReport;
    /** distinct explanations per agent after the checker's equivalence groups (3 = all different; 1 = paraphrases of one idea) */
    diversity: Record<Side, number>;
    selection: Extract<OpinionSelectionResult, { ok: true }>;
    locked: Record<Side, string>;
    telemetry: { generation: Record<Side, CallTelemetry | undefined>; checker: CallTelemetry | undefined };
    llmCalls: number;
  };
};
export type OpinionPrepareResult = OpinionPrepareSuccess | OpinionPrepareFailure;
