// Public API of the AI Courtroom debate engine.
export { createDebateEngine, argumentKey, verdictKey, turnKey } from "./debate";
export type { DebateEngine, EngineOptions } from "./debate";
export { loadEngineConfig, resolveThemeReconciler, ConfigError } from "./config";
export { generateText } from "./providers";
export { selectInjections, selectAudienceBatch, sanitizeInjection } from "./injections";
export { parseVerdict } from "./judge";
export type * from "./types";
export { createAudienceThemeState, parseAudienceThemeState, ingestSubmissions, buildThemeBriefing, markBriefed, applyThemeDelta } from "./themes";
export { createThemeCoordinator } from "./coordinator";
export type { ThemeCoordinator, CoordinatorOptions, SideAudit } from "./coordinator";
// ---- Production integration API for the game backend (see INTEGRATION.md) ----
export { startRound, parseRoundState, serializeRound, publicRoundView, createAiRound } from "./round";
export type {
  AiRound, AiRoundState, AiError, AiErrorCode, AudienceSubmission, PublicArgument, PublicRoundView, CallTelemetry, OpeningStep, TurnStep, JudgeStep,
} from "./round";
