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
  const record = (outcome: GenerateOutcome) => {
    t.requests++;
    if (!outcome.ok) {
      t.failed++;
      t.costKnown = false;
      return;
    }
    const r = outcome.result;
    t.inputTokens += r.inputTokens ?? 0;
    t.outputTokens += r.outputTokens ?? 0;
    if (r.costUsd === undefined) t.costKnown = false;
    else t.costUsd += r.costUsd;
  };
  const onModelCall = (e: ModelCallEvent) => record(e.outcome);
  const summary = () =>
    `requests: ${t.requests} (failed ${t.failed}) | tokens in/out: ${t.inputTokens}/${t.outputTokens} | cost: ${t.costKnown ? "$" + t.costUsd : "n/a (not reported for every call)"}`;
  return { t, record, onModelCall, summary };
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
 * ALL-CLAUDE config: every role uses Anthropic directly. Default model claude-sonnet-5-5, effort low.
 * Overrides (models only, provider is fixed): TEST_AGENT_A_MODEL, TEST_AGENT_B_MODEL, TEST_JUDGE_MODEL;
 * TEST_AGENT_EFFORT / TEST_JUDGE_EFFORT (low|medium|high). A non-anthropic *_PROVIDER variable is rejected.
 */
export function claudeEngineConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  for (const k of ["TEST_PROVIDER", "TEST_AGENT_A_PROVIDER", "TEST_AGENT_B_PROVIDER", "TEST_JUDGE_PROVIDER"])
    if (env[k] && env[k] !== "anthropic") {
      console.error(`${k}=${env[k]} is not allowed here: the all-Claude benchmark uses Anthropic for every call.`);
      process.exit(1);
    }
  const role = (modelVar: string, effortVar: string, judge: boolean): ModelConfig => ({
    provider: "anthropic",
    model: env[modelVar] || "claude-sonnet-5-5",
    maxOutputTokens: judge ? 1500 : 1024,
    timeoutMs: judge ? 45_000 : 30_000,
    maxRetries: 0,
    effort: oneOf(effortVar, env[effortVar], ["low", "medium", "high"] as const) ?? "low",
  });
  return {
    agentA: role("TEST_AGENT_A_MODEL", "TEST_AGENT_EFFORT", false),
    agentB: role("TEST_AGENT_B_MODEL", "TEST_AGENT_EFFORT", false),
    judge: role("TEST_JUDGE_MODEL", "TEST_JUDGE_EFFORT", true),
    argumentMaxWords: 70,
    injections: { maxPerAgent: 3, maxChars: 200 },
    judgeParseRetries: 0, // surface invalid judge JSON instead of hiding it behind a retry
  };
}
