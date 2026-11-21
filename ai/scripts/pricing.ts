// Benchmark-only cost estimation with MODEL-SPECIFIC prices (USD per million tokens). Estimates, not provider-confirmed charges.

export type Price = {
  input: number;
  output: number;
  /** Optional tier for requests whose prompt exceeds `longThreshold` tokens. */
  longInput?: number;
  longOutput?: number;
  longThreshold?: number;
  /** Price of cache-read input tokens, when the provider reports them. */
  cacheRead?: number;
};

/** Published prices for prompts up to 100,000 tokens. Override with --price=<model>:<in>:<out>. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longThreshold: 100_000 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
};

export type CallRecord = {
  role: string;
  model: string;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Only when the provider reports cache usage (the current adapters do not). */
  cacheReadTokens?: number;
};

/** `--price=claude-haiku-5-5:0.1:0.5` (repeatable) replaces that model's input/output price; other fields are kept. */
export function parsePriceOverrides(argv: string[], base: Record<string, Price> = DEFAULT_PRICES): Record<string, Price> {
  const out: Record<string, Price> = { ...base };
  for (const a of argv.filter((x) => x.startsWith("--price="))) {
    const [model, i, o] = a.slice("--price=".length).split(":");
    const input = Number(i);
    const output = Number(o);
    if (!model || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) throw new Error(`--price must look like --price=<model>:<input $/MTok>:<output $/MTok>, got "${a}"`);
    out[model] = { ...(out[model] ?? {}), input, output };
  }
  return out;
}

/** Exact id, or a dated snapshot of it ("<id>-2026..."). */
export function priceFor(model: string, prices: Record<string, Price>): Price | undefined {
  const key = Object.keys(prices).find((k) => k !== "*" && (model === k || model.startsWith(`${k}-`)));
  return key ? prices[key] : prices["*"]; // "*" = optional fallback for models without their own price
}

export function callCostUsd(c: CallRecord, p: Price): number {
  const long = p.longThreshold !== undefined && c.inputTokens > p.longThreshold;
  const inRate = long && p.longInput !== undefined ? p.longInput : p.input;
  const outRate = long && p.longOutput !== undefined ? p.longOutput : p.output;
  const cached = Math.min(c.cacheReadTokens ?? 0, c.inputTokens);
  const cachedRate = cached > 0 && p.cacheRead !== undefined ? p.cacheRead : inRate;
  return ((c.inputTokens - cached) * inRate + cached * cachedRate + c.outputTokens * outRate) / 1e6;
}

export type CostGroup = "debaters" | "judge" | "grouping" | "other";
const groupOf = (role: string): CostGroup => (role === "agentA" || role === "agentB" ? "debaters" : role === "judge" ? "judge" : role === "themes" ? "grouping" : "other");

export type CostReport = {
  totalUsd: number;
  byModel: Record<string, { requests: number; failed: number; inputTokens: number; outputTokens: number; usd: number }>;
  byGroup: Record<CostGroup, { requests: number; failed: number; inputTokens: number; outputTokens: number; usd: number }>;
  /** Models with no known price: their tokens are listed but not costed. */
  unpriced: string[];
};

export function estimateCost(calls: CallRecord[], prices: Record<string, Price> = DEFAULT_PRICES): CostReport {
  const zero = () => ({ requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
  const rep: CostReport = { totalUsd: 0, byModel: {}, byGroup: { debaters: zero(), judge: zero(), grouping: zero(), other: zero() }, unpriced: [] };
  for (const c of calls) {
    const p = priceFor(c.model, prices);
    if (!p && !rep.unpriced.includes(c.model)) rep.unpriced.push(c.model);
    const usd = p ? callCostUsd(c, p) : 0; // a failed request is billed for the tokens the provider reported (0 when none were)
    for (const bucket of [(rep.byModel[c.model] ??= zero()), rep.byGroup[groupOf(c.role)]]) {
      bucket.requests++;
      if (!c.ok) bucket.failed++;
      bucket.inputTokens += c.inputTokens;
      bucket.outputTokens += c.outputTokens;
      bucket.usd += usd;
    }
    rep.totalUsd += usd;
  }
  return rep;
}
