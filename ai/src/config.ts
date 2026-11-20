import type { Effort, EngineConfig, ModelConfig, Provider } from "./types";

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${key} must be a non-negative integer`);
  return n;
}

function modelConfig(env: Env, prefix: string, defaults: { maxTokens: number; timeoutMs: number }): ModelConfig {
  const provider = env[`${prefix}_PROVIDER`] as Provider | undefined;
  const model = env[`${prefix}_MODEL`]?.trim();
  if (provider !== "anthropic" && provider !== "openrouter")
    throw new ConfigError(`${prefix}_PROVIDER must be "anthropic" or "openrouter"`);
  if (!model) throw new ConfigError(`${prefix}_MODEL is required (no default model is assumed)`);
  const effort = env[`${prefix}_EFFORT`] as Effort | undefined;
  if (effort && !["low", "medium", "high"].includes(effort)) throw new ConfigError(`${prefix}_EFFORT must be low|medium|high`);
  return {
    provider,
    model,
    maxOutputTokens: int(env, `${prefix}_MAX_TOKENS`, defaults.maxTokens),
    timeoutMs: int(env, `${prefix}_TIMEOUT_MS`, defaults.timeoutMs),
    maxRetries: int(env, `${prefix}_MAX_RETRIES`, int(env, "AI_MAX_RETRIES", 1)),
    effort: effort || undefined,
  };
}

/** Builds the engine config from environment variables. Throws ConfigError on invalid/missing values. */
export function loadEngineConfig(env: Env = process.env): EngineConfig {
  return {
    agentA: modelConfig(env, "AGENT_A", { maxTokens: 1024, timeoutMs: 25_000 }),
    agentB: modelConfig(env, "AGENT_B", { maxTokens: 1024, timeoutMs: 25_000 }),
    judge: modelConfig(env, "JUDGE", { maxTokens: 2048, timeoutMs: 40_000 }),
    argumentMaxWords: int(env, "AI_ARGUMENT_MAX_WORDS", 90),
    injections: {
      maxPerAgent: int(env, "AI_MAX_INJECTIONS_PER_AGENT", 3),
      maxChars: int(env, "AI_INJECTION_MAX_CHARS", 200),
    },
    judgeParseRetries: int(env, "AI_JUDGE_PARSE_RETRIES", 1),
  };
}
