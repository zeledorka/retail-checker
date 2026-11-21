// MANUAL LIVE TEST (billed): two DeepSeek agents, opening arguments only. No judge, no injections.
//   npm run test:openings
// Requires OPENROUTER_API_KEY in the environment or ai/.env.
import { createDebateEngine } from "../src/index";
import type { EngineConfig, ModelConfig, Scenario } from "../src/types";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file: rely on the shell environment */
}

const MODEL = "deepseek/deepseek-v3.2";

// Scenario lives only in this script. The evidence items restate facts from the description; nothing is added.
const scenario: Scenario = {
  title: "The Bloody Cloth",
  description:
    "A red-stained cloth is discovered in a house the morning after a Halloween party. A neighbour reported hearing an argument the previous evening. Nobody has been reported missing.",
  evidence: [
    "A red-stained cloth was found in the house the morning after a Halloween party",
    "A neighbour reported hearing an argument the previous evening",
    "Nobody has been reported missing",
  ],
  interpretationA: "The cloth is part of a Halloween costume, and the red stains are theatrical blood.",
  interpretationB: "The cloth could be evidence of violence, and the red stains might be real blood.",
};

const agent: ModelConfig = { provider: "openrouter", model: MODEL, maxOutputTokens: 400, timeoutMs: 30_000, maxRetries: 0 };
const config: EngineConfig = {
  agentA: agent,
  agentB: { ...agent },
  judge: { ...agent }, // required by the type, never called in this script
  argumentMaxWords: 60,
  injections: { maxPerAgent: 0, maxChars: 0 },
  judgeParseRetries: 0,
};

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set (put it in ai/.env or your shell environment).");
  process.exit(1);
}

const started = Date.now();
const result = await createDebateEngine(config).generateOpeningArguments({ roundId: `deepseek-openings-${started}`, scenario });
const wallMs = Date.now() - started;

const words = (t: string) => t.trim().split(/\s+/).length;

for (const side of ["A", "B"] as const) {
  const a = result.arguments[side];
  const err = !result.ok ? result.errors[side] : undefined;
  console.log(`\n=== Agent ${side}: ${scenario[side === "A" ? "interpretationA" : "interpretationB"]}`);
  if (a) {
    const m = a.meta;
    console.log(a.text);
    console.log(
      `-- ${words(a.text)} words | model ${m.model} | ${m.latencyMs} ms | tokens in ${m.inputTokens ?? "n/a"} / out ${m.outputTokens ?? "n/a"} | cost ${m.costUsd !== undefined ? "$" + m.costUsd : "n/a"}`,
    );
  } else if (err) {
    console.error(`-- ERROR [${err.kind}] ${err.message}${err.status ? ` (HTTP ${err.status})` : ""}`);
  }
}

console.log(`\nWall-clock total: ${wallMs} ms`);
if (!result.ok) {
  console.error("Opening stage FAILED.");
  process.exitCode = 1;
}
