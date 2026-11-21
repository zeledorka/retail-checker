import type { Effort, EngineConfig, ModelConfig, Provider, ThemesStatus } from "./types";

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${key} must be a non-negative integer`);
  return n;
}

/** The default for every role when nothing is configured: Claude Sonnet 5.5 on Anthropic at low effort (the validated setup). */
export const DEFAULT_PROVIDER: Provider = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_EFFORT: Effort = "low";

function modelConfig(env: Env, prefix: string, defaults: { maxTokens: number; timeoutMs: number }): ModelConfig {
  const configuredModel = env[`${prefix}_MODEL`]?.trim();
  // Unset provider: Anthropic when nothing at all is configured or the model is a claude-* id; otherwise the caller must say which provider.
  const provider = (env[`${prefix}_PROVIDER`] || (!configuredModel || configuredModel.startsWith("claude-") ? DEFAULT_PROVIDER : undefined)) as Provider | undefined;
  if (provider !== "anthropic" && provider !== "openrouter")
    throw new ConfigError(`${prefix}_PROVIDER must be "anthropic" or "openrouter"${configuredModel ? ` (it is required for model "${configuredModel}")` : ""}`);
  // Only an unconfigured Anthropic role gets the default model; a configured model is always used exactly as given.
  const model = configuredModel || (provider === DEFAULT_PROVIDER ? DEFAULT_MODEL : undefined);
  if (!model) throw new ConfigError(`${prefix}_MODEL is required for provider ${provider} (no default model is assumed)`);
  const reasoning = env[`${prefix}_REASONING`] as ModelConfig["reasoning"];
  if (reasoning && !["none", "minimal", "low", "medium", "high"].includes(reasoning)) throw new ConfigError(`${prefix}_REASONING must be none|minimal|low|medium|high`);
  const routeSort = env[`${prefix}_ROUTE_SORT`] as ModelConfig["routeSort"];
  if (routeSort && !["latency", "throughput", "price"].includes(routeSort)) throw new ConfigError(`${prefix}_ROUTE_SORT must be latency|throughput|price`);
  const effort = env[`${prefix}_EFFORT`] as Effort | undefined;
  if (effort && !["low", "medium", "high"].includes(effort)) throw new ConfigError(`${prefix}_EFFORT must be low|medium|high`);
  return {
    provider,
    model,
    maxOutputTokens: int(env, `${prefix}_MAX_TOKENS`, defaults.maxTokens),
    timeoutMs: int(env, `${prefix}_TIMEOUT_MS`, defaults.timeoutMs),
    maxRetries: int(env, `${prefix}_MAX_RETRIES`, int(env, "AI_MAX_RETRIES", 1)),
    effort: effort || (provider === "anthropic" ? DEFAULT_EFFORT : undefined), // Sonnet's reasoning stays on at low effort; never disabled
    reasoning: reasoning || undefined,
    routeSort: routeSort || undefined,
  };
}

const KEY_VAR: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY" };

/**
 * Semantic grouping of audience suggestions is done by the debating agent INSIDE its normal turn request, so no separate
 * reconciliation request exists by default. The old separate reconciler is kept as an OPT-IN: set THEMES_ENABLED=true
 * (reuses the first Anthropic role, A, B, judge) or THEMES_PROVIDER / THEMES_MODEL. It then needs that provider's API key.
 */
export function resolveThemeReconciler(env: Env, roles: ModelConfig[]): { reconciler?: ModelConfig; status: ThemesStatus } {
  const on = ["true", "1", "on", "yes"].includes((env.THEMES_ENABLED ?? "").trim().toLowerCase());
  const override = Boolean(env.THEMES_PROVIDER || env.THEMES_MODEL);
  if (!on && !override)
    return { status: { state: "disabled", source: "none", reason: "semantic grouping is done by the debating agent inside each turn request (set THEMES_ENABLED=true for the optional separate reconciler)" } };
  const base = roles.find((r) => r.provider === "anthropic");
  let reconciler: ModelConfig;
  if (override) {
    const provider = (env.THEMES_PROVIDER as Provider | undefined) ?? "anthropic";
    const model = env.THEMES_MODEL?.trim() || (provider === "anthropic" ? base?.model : undefined);
    reconciler = modelConfig({ ...env, THEMES_PROVIDER: provider, THEMES_MODEL: model }, "THEMES", { maxTokens: 1500, timeoutMs: 20_000 });
  } else if (base) {
    reconciler = { ...base, maxOutputTokens: int(env, "THEMES_MAX_TOKENS", 1500), timeoutMs: int(env, "THEMES_TIMEOUT_MS", 20_000) };
  } else
    return { status: { state: "unavailable", source: "none", reason: "no Anthropic role is configured to reuse; set THEMES_PROVIDER and THEMES_MODEL (no model is substituted automatically)" } };
  const source = override ? "override" : "default";
  if (!env[KEY_VAR[reconciler.provider]])
    return { status: { state: "unavailable", source, provider: reconciler.provider, model: reconciler.model, reason: `${KEY_VAR[reconciler.provider]} is not set` } };
  return { reconciler, status: { state: "enabled", source, provider: reconciler.provider, model: reconciler.model } };
}

/** Builds the engine config from environment variables. Throws ConfigError on invalid/missing values. */
export function loadEngineConfig(env: Env = process.env): EngineConfig {
  // Output caps include adaptive-thinking tokens (Claude 5.5 models think before the visible reply); a structured debating turn needs headroom. Override with AGENT_A_MAX_TOKENS etc.
  const agentA = modelConfig(env, "AGENT_A", { maxTokens: 4096, timeoutMs: 25_000 });
  const agentB = modelConfig(env, "AGENT_B", { maxTokens: 4096, timeoutMs: 25_000 });
  const judge = modelConfig(env, "JUDGE", { maxTokens: 2500, timeoutMs: 40_000 });
  const themes = resolveThemeReconciler(env, [agentA, agentB, judge]);
  return {
    agentA,
    agentB,
    judge,
    argumentMaxWords: int(env, "AI_ARGUMENT_MAX_WORDS", 70),
    injections: {
      maxPerAgent: int(env, "AI_MAX_INJECTIONS_PER_AGENT", 3),
      maxChars: int(env, "AI_INJECTION_MAX_CHARS", 200),
      batchChars: int(env, "AI_INJECTION_BATCH_CHARS", 10_000),
      batchMaxMessages: int(env, "AI_INJECTION_BATCH_MAX_MESSAGES", 200),
      maxPerPlayer: int(env, "AI_INJECTION_MAX_PER_PLAYER", 2),
    },
    judgeParseRetries: int(env, "AI_JUDGE_PARSE_RETRIES", 1),
    turnMaxWords: int(env, "AI_TURN_MAX_WORDS", 45),
    reconciler: themes.reconciler,
    themesStatus: themes.status,
    themes: {
      briefingThemes: int(env, "AI_THEME_BRIEFING_THEMES", 200),
      briefingChars: int(env, "AI_THEME_BRIEFING_CHARS", 20_000),
      maxNewPerRequest: int(env, "AI_THEME_MAX_NEW_PER_REQUEST", 40),
      maxExistingPerRequest: int(env, "AI_THEME_MAX_EXISTING_PER_REQUEST", 30),
      maxRequests: int(env, "AI_THEME_MAX_REQUESTS", 2),
      deadlineMs: int(env, "AI_THEME_DEADLINE_MS", 20_000),
    },
  };
}
