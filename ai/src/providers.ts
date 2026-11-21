import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { GenerateOutcome, GenerateRequest, ModelConfig, ModelError, ModelErrorKind, Provider } from "./types";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Both SDKs expose the same error class family; type it structurally.
type ErrorClasses = {
  APIUserAbortError: abstract new (...args: never[]) => Error;
  APIConnectionTimeoutError: abstract new (...args: never[]) => Error;
  APIConnectionError: abstract new (...args: never[]) => Error;
  RateLimitError: abstract new (...args: never[]) => Error;
  AuthenticationError: abstract new (...args: never[]) => Error;
  PermissionDeniedError: abstract new (...args: never[]) => Error;
  BadRequestError: abstract new (...args: never[]) => Error;
  APIError: abstract new (...args: never[]) => Error;
};

/** Removes anything that looks like an API key before an error message leaves this module. */
export function redact(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

function classify(err: unknown, sdk: ErrorClasses, provider: Provider, model: string, latencyMs: number): ModelError {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
  let kind: ModelErrorKind = "provider_error";
  if (err instanceof sdk.APIUserAbortError) kind = "aborted";
  else if (err instanceof sdk.APIConnectionTimeoutError) kind = "timeout";
  else if (err instanceof sdk.APIConnectionError) kind = "connection";
  else if (err instanceof sdk.RateLimitError) kind = "rate_limit";
  else if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) kind = "auth";
  else if (err instanceof sdk.BadRequestError) kind = "bad_request";
  else if (!(err instanceof sdk.APIError)) kind = "provider_error";
  const retryable = kind === "timeout" || kind === "connection" || kind === "rate_limit" || (status !== undefined && status >= 500);
  const raw = err instanceof Error ? err.message : String(err);
  return { kind, message: redact(`${provider} ${model}: ${raw}`), provider, model, status, retryable, latencyMs };
}

function fail(kind: ModelErrorKind, message: string, config: ModelConfig, latencyMs?: number): GenerateOutcome {
  return {
    ok: false,
    error: { kind, message, provider: config.provider, model: config.model, retryable: false, latencyMs },
  };
}

// Clients are cached per key so Next.js route handlers reuse connections.
const anthropicClients = new Map<string, Anthropic>();
const openrouterClients = new Map<string, OpenAI>();

type AnthropicLike = {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
};

/**
 * Maps a Messages API response to our outcome. Pure, so it is unit-tested without the network.
 * A reply cut at max_tokens is still a FAILURE (kind "truncated"), but it keeps the usage the provider reported and the
 * visible text received, so the cost is known and a caller may recover a complete, readable part of it. Thinking tokens
 * count against max_tokens, so the visible text can be short or empty even when outputTokens equals the cap.
 */
export function interpretAnthropicResponse(res: AnthropicLike, config: ModelConfig, latencyMs: number): GenerateOutcome {
  const text = res.content
    .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
    .join("")
    .trim();
  const inputTokens = res.usage?.input_tokens;
  const outputTokens = res.usage?.output_tokens;
  const failed = (kind: ModelErrorKind, message: string, partialText?: string): GenerateOutcome => ({
    ok: false,
    error: { kind, message, provider: "anthropic", model: res.model ?? config.model, retryable: false, latencyMs, inputTokens, outputTokens, ...(partialText ? { partialText } : {}) },
  });
  if (res.stop_reason === "refusal") return failed("refusal", "Model declined to answer");
  if (res.stop_reason === "max_tokens")
    return failed("truncated", `Output hit maxOutputTokens (${config.maxOutputTokens}; ${outputTokens ?? "?"} output tokens used, ${text.length} visible characters received; thinking tokens count toward the cap)`, text);
  if (!text) return failed("empty_output", "Model returned no text");
  return {
    ok: true,
    result: { text, provider: "anthropic", model: res.model ?? config.model, latencyMs, inputTokens, outputTokens, costUsd: undefined }, // cost is not reported by the API; not estimated here
  };
}

async function callAnthropic(config: ModelConfig, req: GenerateRequest): Promise<GenerateOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail("config", "ANTHROPIC_API_KEY is not set", config);
  let client = anthropicClients.get(apiKey);
  if (!client) anthropicClients.set(apiKey, (client = new Anthropic({ apiKey })));

  const started = Date.now();
  try {
    const res = await client.messages.create(
      {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        ...(config.effort ? { output_config: { effort: config.effort } } : {}),
        ...(config.thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
      },
      { timeout: config.timeoutMs, maxRetries: config.maxRetries, signal: req.signal },
    );
    return interpretAnthropicResponse(res, config, Date.now() - started);
  } catch (err) {
    return { ok: false, error: classify(err, Anthropic, "anthropic", config.model, Date.now() - started) };
  }
}

function openRouterExtras(config: ModelConfig): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (config.temperature !== undefined) extra.temperature = config.temperature;
  if (config.reasoning) extra.reasoning = { effort: config.reasoning };
  if (config.routeSort) extra.provider = { sort: config.routeSort };
  return extra;
}

async function callOpenRouter(config: ModelConfig, req: GenerateRequest): Promise<GenerateOutcome> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return fail("config", "OPENROUTER_API_KEY is not set", config);
  let client = openrouterClients.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL, defaultHeaders: { "X-Title": "AI Courtroom" } });
    openrouterClients.set(apiKey, client);
  }

  const started = Date.now();
  try {
    const res = await client.chat.completions.create(
      {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        ...openRouterExtras(config),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      },
      { timeout: config.timeoutMs, maxRetries: config.maxRetries, signal: req.signal },
    );
    const latencyMs = Date.now() - started;
    const choice = res.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();
    if (choice?.finish_reason === "length") return fail("truncated", "Output hit maxOutputTokens", config, latencyMs);
    if (choice?.finish_reason === "content_filter") return fail("refusal", "Provider content filter", config, latencyMs);
    if (!text) return fail("empty_output", "Model returned no text", config, latencyMs);
    // OpenRouter adds `cost` (USD credits) to usage; only use it when actually present.
    const cost = (res.usage as unknown as { cost?: unknown } | undefined)?.cost;
    return {
      ok: true,
      result: {
        text,
        provider: "openrouter",
        model: res.model ?? config.model,
        latencyMs,
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: res.usage?.completion_tokens,
        reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
        costUsd: typeof cost === "number" ? cost : undefined,
      },
    };
  } catch (err) {
    return { ok: false, error: classify(err, OpenAI, "openrouter", config.model, Date.now() - started) };
  }
}

/** Unified entry point. Never throws; never switches model or provider. */
export async function generateText(config: ModelConfig, req: GenerateRequest): Promise<GenerateOutcome> {
  switch (config.provider) {
    case "anthropic":
      return callAnthropic(config, req);
    case "openrouter":
      return callOpenRouter(config, req);
    default:
      return fail("config", `Unknown provider: ${String((config as { provider: unknown }).provider)}`, config);
  }
}
