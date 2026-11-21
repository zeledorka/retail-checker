import { resolveThemeReconciler } from "../src/config";
// Shared helpers for the manual live-test scripts only (not production code).
import type { ArgumentOutput, EngineConfig, GenerateOutcome, ModelCallEvent, ModelConfig, ModelResult, Provider } from "../src/types";

export function loadEnv() {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* no .env file: rely on the shell environment */
  }
}

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T | undefined {
  if (!v) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    console.error(`${name} must be one of: ${allowed.join(", ")}`);
    process.exit(1);
  }
  return v as T;
}
const REASONING = ["none", "minimal", "low", "medium", "high"] as const;
const SORTS = ["latency", "throughput", "price"] as const;

const KEY_VAR: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY" };

function pick(v: string | undefined, fallback: Provider): Provider {
  const p = v ?? fallback;
  if (p !== "anthropic" && p !== "openrouter") {
    console.error(`Provider must be "anthropic" or "openrouter", got "${p}"`);
    process.exit(1);
  }
  return p;
}

function intEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return n;
}

type Role = "AGENT_A" | "AGENT_B" | "JUDGE";

function roleConfig(role: Role, base: { provider: Provider; model: string }): ModelConfig {
  const e = process.env;
  const judge = role === "JUDGE";
  const provider = pick(e[`TEST_${role}_PROVIDER`], base.provider);
  let model = e[`TEST_${role}_MODEL`];
  if (!model) {
    if (provider !== base.provider) {
      console.error(`TEST_${role}_MODEL is required when TEST_${role}_PROVIDER differs from the base provider (${base.provider}).`);
      process.exit(1);
    }
    model = base.model;
  }
  const kind = judge ? "JUDGE" : "AGENT";
  return {
    provider,
    model,
    maxOutputTokens: intEnv(`TEST_${kind}_MAX_TOKENS`) ?? (provider === "anthropic" ? (judge ? 1500 : 1024) : judge ? 800 : 400),
    timeoutMs: judge ? 45_000 : 30_000,
    maxRetries: 0,
    temperature: judge ? 0.2 : 0.7, // OpenRouter only; Anthropic ignores it
    effort: oneOf(`TEST_${kind}_EFFORT`, e[`TEST_${kind}_EFFORT`], ["low", "medium", "high"] as const), // Anthropic only
    reasoning: oneOf(judge ? "TEST_JUDGE_REASONING" : "TEST_REASONING", e[judge ? "TEST_JUDGE_REASONING" : "TEST_REASONING"], REASONING),
    routeSort: oneOf(judge ? "TEST_JUDGE_ROUTE_SORT" : "TEST_ROUTE_SORT", e[judge ? "TEST_JUDGE_ROUTE_SORT" : "TEST_ROUTE_SORT"], SORTS),
  };
}

/**
 * Test engine config: DeepSeek V3.2 on OpenRouter by default. All overrides are optional environment variables:
 *   Both agents:  TEST_PROVIDER, TEST_MODEL
 *   Per role:     TEST_AGENT_A_PROVIDER / _MODEL, TEST_AGENT_B_PROVIDER / _MODEL, TEST_JUDGE_PROVIDER / _MODEL
 *                 (a role whose provider differs from the base provider must also set its _MODEL)
 *   Tuning:       TEST_AGENT_MAX_TOKENS, TEST_JUDGE_MAX_TOKENS, TEST_AGENT_EFFORT, TEST_JUDGE_EFFORT (Anthropic, low|medium|high),
 *                 TEST_REASONING, TEST_ROUTE_SORT, TEST_JUDGE_REASONING, TEST_JUDGE_ROUTE_SORT (OpenRouter)
 */
export function testEngineConfig(): EngineConfig {
  const base = { provider: pick(process.env.TEST_PROVIDER, "openrouter"), model: process.env.TEST_MODEL || "deepseek/deepseek-v3.2" };
  return {
    agentA: roleConfig("AGENT_A", base),
    agentB: roleConfig("AGENT_B", base),
    judge: roleConfig("JUDGE", base),
    argumentMaxWords: 70,
    injections: { maxPerAgent: 3, maxChars: 200 },
    judgeParseRetries: 0, // surface invalid judge JSON instead of hiding it behind a retry
  };
}

export const describeModels = (c: EngineConfig) =>
  `A=${c.agentA.provider}:${c.agentA.model} | B=${c.agentB.provider}:${c.agentB.model} | judge=${c.judge.provider}:${c.judge.model}`;

export function requireKeys(config: EngineConfig, useJudge: boolean) {
  const providers = new Set<Provider>([config.agentA.provider, config.agentB.provider]);
  if (useJudge) providers.add(config.judge.provider);
  for (const p of providers)
    if (!process.env[KEY_VAR[p]]) {
      console.error(`${KEY_VAR[p]} is not set (put it in ai/.env or your shell environment).`);
      process.exit(1);
    }
}

/** Accumulates request count, tokens and cost across all model calls via the engine's onModelCall hook. */
export function makeTracker() {
  const t = { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true };
  /** Every request with its role and model, for per-model cost and per-role reporting. */
  const calls: { role: string; model: string; ok: boolean; latencyMs?: number; inputTokens: number; outputTokens: number; kind?: string }[] = [];
  const record = (outcome: GenerateOutcome, role = "other") => {
    t.requests++;
    if (!outcome.ok) {
      t.failed++;
      t.costKnown = false;
      // a truncated / refused request still consumed (and is billed for) the tokens the provider reported
      const e = outcome.error;
      calls.push({ role, model: e.model ?? "unknown", ok: false, latencyMs: e.latencyMs, inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0, kind: e.kind });
      t.inputTokens += e.inputTokens ?? 0;
      t.outputTokens += e.outputTokens ?? 0;
      return;
    }
    const r = outcome.result;
    calls.push({ role, model: r.model, ok: true, latencyMs: r.latencyMs, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 });
    t.inputTokens += r.inputTokens ?? 0;
    t.outputTokens += r.outputTokens ?? 0;
    if (r.costUsd === undefined) t.costKnown = false;
    else t.costUsd += r.costUsd;
  };
  const onModelCall = (e: ModelCallEvent) => record(e.outcome, e.role);
  const summary = () =>
    `requests: ${t.requests} (failed ${t.failed}) | tokens in/out: ${t.inputTokens}/${t.outputTokens} | cost: ${t.costKnown ? "$" + t.costUsd : "n/a (not reported for every call)"}`;
  return { t, calls, record, onModelCall, summary };
}

export const wordCount = (s: string) => s.trim().split(/\s+/).length;

export function printArgument(label: string, a: ArgumentOutput, maxWords?: number) {
  const m = a.meta;
  console.log(`\n  ${label} — injections used: ${a.injectionIdsUsed.length ? a.injectionIdsUsed.join(", ") : "none"}`);
  console.log(`  ${a.text}`);
  const words = wordCount(a.text);
  console.log(
    `  (${words} words${maxWords !== undefined && words > maxWords ? ` — OVER LIMIT ${maxWords}` : ""} | ${m.model} | ${m.latencyMs} ms | tokens in/out ${m.inputTokens ?? "n/a"}/${m.outputTokens ?? "n/a"}${m.reasoningTokens ? ` (reasoning ${m.reasoningTokens})` : ""} | cost ${m.costUsd !== undefined ? "$" + m.costUsd : "n/a"})`,
  );
}

/** One-line request metadata: model, latency, tokens (reasoning when reported) and cost (only when reported). */
export function describeMeta(m: Omit<ModelResult, "text">): string {
  return `${m.model} | ${m.latencyMs} ms | tokens in/out ${m.inputTokens ?? "n/a"}/${m.outputTokens ?? "n/a"} | reasoning tokens ${m.reasoningTokens ?? "n/a"} | cost ${m.costUsd !== undefined ? "$" + m.costUsd : "n/a"}`;
}

/**
 * Default Claude roles: Sonnet 5.5 for both debaters and the judge (the validated setup: it grouped the 200-player audience
 * more reliably than Haiku). Each role stays separately configurable, so Haiku comparisons still work (--agents-model=claude-haiku-5-5).
 */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";
/**
 * Output-token cap per model (it includes adaptive-thinking tokens, which both Claude 5.5 models spend before the visible reply).
 * A debating turn must hold the argument (~70 tokens) plus the compact grouping for up to ~100 distinct wordings (~800 tokens
 * visible) and the thinking; 1,400 was too small for Haiku (Turn 3 hit the cap). Haiku 5.5 gets 4,096; other agents 2,500; judge 2,500.
 * Override per run with TEST_AGENT_MAX_TOKENS / TEST_JUDGE_MAX_TOKENS (--agents-max-tokens / --judge-max-tokens).
 */
export function defaultMaxOutputTokens(model: string, judge: boolean): number {
  return judge ? 2500 : model.startsWith("claude-haiku") ? 4096 : 2500;
}

/** Model ids the benchmark accepts without --allow-unknown-model. An unknown id is an error, never a silent substitution. */
export const KNOWN_CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"];

/**
 * ALL-CLAUDE config: every role uses Anthropic directly. Defaults: agents claude-haiku-5-5, judge claude-sonnet-5-5, effort low.
 * Overrides (models only, provider is fixed): TEST_AGENT_A_MODEL, TEST_AGENT_B_MODEL, TEST_JUDGE_MODEL;
 * TEST_AGENT_EFFORT / TEST_JUDGE_EFFORT (low|medium|high). A non-anthropic *_PROVIDER variable is rejected.
 */
export function claudeEngineConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  for (const k of ["TEST_PROVIDER", "TEST_AGENT_A_PROVIDER", "TEST_AGENT_B_PROVIDER", "TEST_JUDGE_PROVIDER"])
    if (env[k] && env[k] !== "anthropic") {
      console.error(`${k}=${env[k]} is not allowed here: the all-Claude benchmark uses Anthropic for every call.`);
      process.exit(1);
    }
  const role = (modelVar: string, effortVar: string, judge: boolean): ModelConfig => {
    const model = env[modelVar] || (judge ? DEFAULT_JUDGE_MODEL : DEFAULT_AGENT_MODEL);
    const maxVar = judge ? "TEST_JUDGE_MAX_TOKENS" : "TEST_AGENT_MAX_TOKENS";
    const cap = env[maxVar] === undefined || env[maxVar] === "" ? defaultMaxOutputTokens(model, judge) : Number(env[maxVar]);
    if (!Number.isInteger(cap) || cap < 256 || cap > 64_000) {
      console.error(`${maxVar} must be an integer between 256 and 64000`);
      process.exit(1);
    }
    return {
      provider: "anthropic",
      model,
      maxOutputTokens: cap,
      timeoutMs: judge ? 45_000 : 30_000,
      maxRetries: 0,
      effort: oneOf(effortVar, env[effortVar], ["low", "medium", "high"] as const) ?? "low",
      ...(!judge && oneOf("TEST_AGENT_THINKING", env.TEST_AGENT_THINKING, ["disabled"] as const) ? { thinking: "disabled" as const } : {}),
    };
  };
  const agentA = role("TEST_AGENT_A_MODEL", "TEST_AGENT_EFFORT", false);
  const agentB = role("TEST_AGENT_B_MODEL", "TEST_AGENT_EFFORT", false);
  const judge = role("TEST_JUDGE_MODEL", "TEST_JUDGE_EFFORT", true);
  // Semantic grouping: on by default, reusing agent A's Claude model. THEMES_ENABLED=false turns it off; THEMES_MODEL overrides.
  const themes = resolveThemeReconciler(env, [agentA, agentB, judge]);
  return {
    agentA,
    agentB,
    judge,
    reconciler: themes.reconciler,
    themesStatus: themes.status,
    argumentMaxWords: 70,
    injections: { maxPerAgent: 3, maxChars: 200 },
    judgeParseRetries: 0, // surface invalid judge JSON instead of hiding it behind a retry
  };
}
