// Public API of the AI Courtroom debate engine.
export { createDebateEngine, argumentKey, verdictKey, turnKey } from "./debate";
export type { DebateEngine, EngineOptions } from "./debate";
export { loadEngineConfig, ConfigError } from "./config";
export { generateText } from "./providers";
export { selectInjections, sanitizeInjection } from "./injections";
export { parseVerdict } from "./judge";
export type * from "./types";
