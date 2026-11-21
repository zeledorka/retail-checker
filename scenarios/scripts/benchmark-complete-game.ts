// LIVE (billed) complete-game benchmark: ONE new scenario + image + independent opinions, then two openings, eight turns with a simulated
// 200-member audience, and one independent judgment. 15 Claude requests + 1 OpenRouter image request = 16 paid requests. No retries, no fallback.
//
//   npx tsx scripts/benchmark-complete-game.ts                                  -> prints the plan and checks configuration, makes ZERO requests
//   npx tsx scripts/benchmark-complete-game.ts --approved --env-file=<ai/.env>  -> runs it (only after explicit approval)
// Options: --seed=<int>  --out=<dir> (default scenarios/output, git-ignored)
// The 200 simulated users test audience processing and scalability only: this is NOT a real 200-client multiplayer load test.
import { join } from "node:path";
import { generateText } from "../../ai/src/index";
import { DEFAULT_IMAGE_MODEL, createOpenRouterImageGenerator, runCompleteGame, verifyImageModel } from "../src/index";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const approved = process.argv.includes("--approved");
const seed = Number(arg("seed") ?? 2026);
const outDir = arg("out") ?? join(process.cwd(), "output");
if (!Number.isInteger(seed)) {
  console.error("--seed must be an integer. No request was made.");
  process.exit(1);
}
// Load --env-file first so the configuration report below is accurate (loading makes no request and never overrides variables already set).
const envFile = arg("env-file");
if (envFile) {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.error(`Could not read --env-file: ${(e as Error).message}. No request was made.`);
    process.exit(1);
  }
}
const imageModel = process.env.OPENROUTER_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
console.log("Complete-game benchmark plan (one integrated round)");
console.log("  A  prepareNewRound: 1 scenario + [image  ||  2 opinion generations -> 1 blind checker]  (image and opinions in parallel)");
console.log("  B  startRound + createAiRound (claude-sonnet-5-5, low effort, SDK retries 0, judge parse retries 0)");
console.log("  C  opening A, then opening B (sequential, state saved after each)");
console.log("  D  200 synthetic audience submissions built locally (100 per side, one per player, no model call)");
console.log("  E  eight sequential debate turns with a cumulative audience, state saved after each");
console.log("  F  one independent judgment (public transcript only)");
console.log(`  Requests: 4 Claude (preparation) + 2 openings + 8 turns + 1 judge = 15 Claude, plus 1 OpenRouter image (${imageModel}) = 16 paid requests. Hard caps 15 + 1.`);
console.log(`  Output: ${outDir}/game-<timestamp>/ (public/ and private/; git-ignored). Estimated cost: roughly $0.10-0.20 (estimate only).`);
console.log(`  Configuration: ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT set"}, OPENROUTER_API_KEY ${process.env.OPENROUTER_API_KEY ? "set" : "NOT set"}, OPENROUTER_IMAGE_MODEL ${process.env.OPENROUTER_IMAGE_MODEL ? "set" : "default"}, seed ${seed}`);
if (!approved) {
  console.log("\nNOT RUN: no --approved flag, so no request was made.");
  process.exit(0);
}
for (const k of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} is not set (use --env-file=...). No request was made.`);
    process.exit(1);
  }
}
const catalog = await verifyImageModel(imageModel); // free GET, no key, no charge
console.log(`\nImage model catalog check (free): ${catalog.message}`);
if (!catalog.ok) {
  console.error("Stopping before any paid request.");
  process.exit(1);
}

const r = await runCompleteGame({ seed, generate: generateText, imageGenerator: createOpenRouterImageGenerator(), outDir });

console.log(`\n${"=".repeat(88)}\nRESULT: ${r.ok ? "PASSED" : "FAILED"}${r.failedStage ? ` at stage ${r.failedStage}` : ""}${r.error ? `: ${r.error}` : ""}`);
console.log(`Requests: Claude ${r.requests.claude}/${r.requests.caps.claude}, image ${r.requests.image}/${r.requests.caps.image} | ${JSON.stringify(r.requests.byKind)}`);
for (const line of r.criticalPath) console.log(`  ${line}`);
for (const q of r.requests.log) console.log(`  ${q.kind.padEnd(19)} ${q.stage.padEnd(8)} ${String(Math.round(q.ms)).padStart(6)} ms  tokens ${q.inputTokens ?? "-"}/${q.outputTokens ?? "-"}${q.ok ? "" : `  FAILED ${q.error}`}`);
console.log(`Estimated Claude cost $${r.usage.estimatedClaudeUsd.toFixed(4)} (assumed $2/$10 per million tokens; not a provider charge); image ${r.usage.imageCostUsd !== undefined ? `ACTUAL $${r.usage.imageCostUsd}` : "no cost reported"}`);
const bad = r.checks.filter((c) => c.status !== "pass");
console.log(`\nChecks: ${r.checks.filter((c) => c.status === "pass").length} pass, ${r.checks.filter((c) => c.status === "fail").length} FAIL, ${r.checks.filter((c) => c.status === "review").length} need human review`);
for (const c of bad) console.log(`  [${c.status.toUpperCase()}] ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
if (r.verdict) console.log(`\nVerdict: Agent ${r.verdict.winner} wins | scores ${JSON.stringify(r.verdict.scores)}`);
console.log(`\nSaved under ${r.runDir}:\n  ${r.files.join("\n  ")}`);
process.exit(r.ok ? 0 : 1);
