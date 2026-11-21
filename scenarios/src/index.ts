// Public entry point of the pre-round preparation pipeline (Developer 2). See HANDOFF.md.
export type * from "./types";
export { validateScenarioCase, scenarioCaseSchema, similarity, MAX_INTERPRETATION_SIMILARITY } from "./schema";
export { generatePersonality, describePersonality, newSeed, hashSeed, mulberry32 } from "./personality";
export { createLlmRanker, createMockRanker, createSeededMockRanker, buildRankingPrompt, parseRankingReply, RANKER_MODEL, RANKER_SYSTEM } from "./ranking";
export { selectOpinions, validateRanking, DEFAULT_MIN_STRENGTH, DEFAULT_RANK_BONUS, DEFAULT_TIE_MARGIN } from "./selector";
export { prepareRound, prepareFromPool } from "./prepare";
export { PREPARED_CASES } from "./prepared-cases";
export { generateScenarioBatch, buildGenerationPrompt, GENERATOR_SYSTEM, GENERATOR_MODEL } from "./generator";

// ---- Independent opinion generation + checker pipeline (current). The ranking pipeline above is the previous design, kept for history. ----
export type {
  EvidenceItem, CheckerFlag, ScenarioInput, RawOpinion, GeneratedOpinion, GenerationRequest, GenerationResult, OpinionGenerator, CheckerOpinion, CheckerAssessment, PairJudgement,
  CheckerReport, CheckResult, OpinionChecker, FinalSelectionOptions, OpinionPair, OpinionSelectionResult, OpinionSelectionDiagnostics, OpinionPrepareResult, OpinionPrepareSuccess, OpinionPrepareFailure, StageError,
} from "./opinion-types";
export { validateScenarioInput, toScenarioInput, PREPARED_SCENARIOS } from "./scenario-input";
export { createLlmOpinionGenerator, createMockGenerator, createSeededMockGenerator, rawOpinion, validateOpinions, parseOpinionReply, buildOpinionPrompt, OPINION_SYSTEM, GENERATOR_MODEL as OPINION_MODEL } from "./opinions";
export { createLlmChecker, createMockChecker, createHeuristicMockChecker, anonymise, buildCheckerPrompt, validateCheckerReport, parseCheckerReply, CHECKER_SYSTEM, CHECKER_MODEL } from "./checker";
export { selectFinalPair, DEFAULT_SELECTION } from "./opinion-selector";
export { prepareScenario } from "./prepare-opinions";
export { analyseRun } from "./opinion-diagnostics";
export type { PartialMeta } from "./opinion-types";
