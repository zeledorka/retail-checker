// MANUAL LIVE TEST (billed): do two identically-configured DeepSeek agents form the same opinion on their own?
//   npm run test:opinions
// Requires OPENROUTER_API_KEY in the environment or ai/.env. No positions assigned, no judge, no retries.
import { z } from "zod";
import { generateText } from "../src/index";
import type { GenerateOutcome, ModelConfig } from "../src/types";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file: rely on the shell environment */
}

// Scenario lives only in this script.
const SCENARIO =
  "A red-stained cloth is discovered in a house the morning after a Halloween party. A neighbour reported hearing an argument the previous evening. Nobody has been reported missing.";

const SYSTEM = [
  "You are examining an ambiguous scenario.",
  "Independently determine what you think most likely happened based only on the supplied information.",
  "Choose your own interpretation without being given predefined alternatives.",
  "Explain your conclusion briefly, using available evidence.",
  "Distinguish observations from assumptions. Do not invent additional evidence.",
  "You may express uncertainty, but you must provide your leading interpretation.",
  "Do not attempt to agree or disagree with another agent.",
  "Keep your explanation under 60 words.",
  "",
  'Reply with ONLY a JSON object, no markdown: {"interpretation":"short description of your chosen explanation","reasoning":"your brief justification (under 60 words)","confidence":0-100 integer}',
].join("\n");

const PROMPT = `SCENARIO:\n${SCENARIO}`;

const config: ModelConfig = {
  provider: "openrouter",
  model: "deepseek/deepseek-v3.2",
  maxOutputTokens: 400,
  timeoutMs: 30_000,
  maxRetries: 0,
  temperature: 0.7,
};

const opinionSchema = z.object({
  interpretation: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
  confidence: z.coerce.number().int().min(0).max(100),
});

function parseOpinion(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false as const, reason: "no JSON object in output" };
  try {
    const r = opinionSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return r.success ? { ok: true as const, value: r.data } : { ok: false as const, reason: `validation failed: ${r.error.issues[0]?.message}` };
  } catch {
    return { ok: false as const, reason: "output is not valid JSON" };
  }
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set (put it in ai/.env or your shell environment).");
  process.exit(1);
}

const started = Date.now();
// Two separate, parallel requests with identical input and no shared state.
const outcomes: GenerateOutcome[] = await Promise.all([generateText(config, { system: SYSTEM, prompt: PROMPT }), generateText(config, { system: SYSTEM, prompt: PROMPT })]);
const wallMs = Date.now() - started;

let failed = false;
let totalCost = 0;
let costKnown = true;

outcomes.forEach((o, i) => {
  console.log(`\n=== Agent ${i === 0 ? "A" : "B"} ===`);
  if (!o.ok) {
    failed = true;
    costKnown = false;
    console.error(`ERROR [${o.error.kind}] ${o.error.message}${o.error.status ? ` (HTTP ${o.error.status})` : ""}`);
    return;
  }
  const m = o.result;
  if (m.costUsd === undefined) costKnown = false;
  else totalCost += m.costUsd;
  const parsed = parseOpinion(m.text);
  if (parsed.ok) {
    console.log(`Interpretation: ${parsed.value.interpretation}`);
    console.log(`Reasoning:      ${parsed.value.reasoning}`);
    console.log(`Confidence:     ${parsed.value.confidence}`);
  } else {
    failed = true;
    console.error(`INVALID OUTPUT: ${parsed.reason}\nRaw output:\n${m.text}`);
  }
  console.log(
    `Model: ${m.model} | Latency: ${m.latencyMs} ms | Tokens in/out: ${m.inputTokens ?? "n/a"}/${m.outputTokens ?? "n/a"} | Cost: ${m.costUsd !== undefined ? "$" + m.costUsd : "n/a"}`,
  );
});

console.log(`\nWall-clock total: ${wallMs} ms`);
console.log(`Total reported cost: ${costKnown ? "$" + totalCost : "n/a (not reported for every call)"}`);
if (failed) {
  console.error("Test FAILED: at least one agent errored or returned invalid output.");
  process.exitCode = 1;
}
