// LIVE (billed) benchmark of the FULL pre-round pipeline: new scenario + image (parallel with) independent opinions.
// Plan: 1 scenario request + 1 OpenRouter image request + 2 opinion requests + 1 checker request = 5 paid requests, NO retries, NO fallback.
//
//   npx tsx scripts/benchmark-full-generation.ts                                  -> prints the plan only, makes ZERO requests
//   npx tsx scripts/benchmark-full-generation.ts --approved --env-file=<ai/.env>  -> runs it (only after explicit approval)
// Options: --seed=<int>  --out=<dir> (default scenarios/output, git-ignored)  --env-file=<file with ANTHROPIC_API_KEY and OPENROUTER_API_KEY>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "../../ai/src/index";
import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { CHECKER_SYSTEM, DEFAULT_IMAGE_MODEL, OPINION_SYSTEM, SCENARIO_SYSTEM, analyseRun, createLlmChecker, createLlmOpinionGenerator, createOpenRouterImageGenerator, prepareNewRound, verifyImageModel } from "../src/index";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
export const approved = process.argv.includes("--approved");
export const seed = Number(arg("seed") ?? 2026);
export const outDir = arg("out") ?? join(process.cwd(), "output");
export const CLAUDE_CAP = 4; // scenario + 2 opinion generations + 1 checker
export const IMAGE_CAP = 1;
export const PRICE = { input: 2, output: 10 }; // USD per million tokens, Sonnet 5.5: an ESTIMATE, not a provider charge

if (!Number.isInteger(seed)) {
  console.error("--seed must be an integer. No request was made.");
  process.exit(1);
}
// Load --env-file BEFORE anything reports or reads the environment (loading makes no request and never overrides variables already set).
const envFile = arg("env-file");
if (envFile) {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.error(`Could not read --env-file: ${(e as Error).message}. No request was made.`);
    process.exit(1);
  }
}
console.log("Full-generation benchmark plan");
console.log(`  Claude (claude-sonnet-5-5, low effort): 1 scenario + 2 opinion generations + 1 checker = ${CLAUDE_CAP} requests`);
console.log(`  OpenRouter image (${process.env.OPENROUTER_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL}): ${IMAGE_CAP} request, 16:9, runs in parallel with the opinion requests`);
console.log(`  Total ${CLAUDE_CAP + IMAGE_CAP} paid requests. No retries, no fallback. Seed ${seed}. Output folder ${outDir} (git-ignored).`);
console.log("  Estimated cost: roughly $0.04-0.07 (Claude about $0.02-0.03 by token estimate, image about $0.03; estimates only).");
console.log(`  Environment: ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? "set" : "not set"}, OPENROUTER_API_KEY ${process.env.OPENROUTER_API_KEY ? "set" : "not set"}, OPENROUTER_IMAGE_MODEL ${process.env.OPENROUTER_IMAGE_MODEL ? "set" : "default"}`);
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
const imageModel = process.env.OPENROUTER_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
const catalog = await verifyImageModel(imageModel); // free GET, no key, no charge
console.log(`\nImage model catalog check (free): ${catalog.message}`);
if (!catalog.ok) {
  console.error("Stopping before any paid request.");
  process.exit(1);
}

type Call = { kind: string; ms: number; inputTokens?: number; outputTokens?: number; error?: string; raw?: string };
const calls: Call[] = [];
let claude = 0;
const counted: GenerateTextFn = async (cfg, req) => {
  if (claude >= CLAUDE_CAP) throw new Error(`Claude request cap ${CLAUDE_CAP} reached`);
  claude++;
  const kind = req.system === SCENARIO_SYSTEM ? "scenario" : req.system === OPINION_SYSTEM ? "opinion-generation" : req.system === CHECKER_SYSTEM ? "checker" : "unknown";
  const t0 = Date.now();
  const out: GenerateOutcome = await generateText(cfg, req);
  const ms = Date.now() - t0;
  calls.push(out.ok ? { kind, ms, inputTokens: out.result.inputTokens, outputTokens: out.result.outputTokens, raw: out.result.text } : { kind, ms, inputTokens: out.error.inputTokens, outputTokens: out.error.outputTokens, error: `[${out.error.kind}] ${out.error.message}`, raw: out.error.partialText });
  return out;
};

const realImage = createOpenRouterImageGenerator();
let imageCalls = 0;
let imageRaw: { ok: boolean; ms: number; costUsd?: number; error?: string } | undefined;
const imageGenerator = {
  async generate(req: Parameters<typeof realImage.generate>[0]) {
    if (imageCalls >= IMAGE_CAP) throw new Error("image request cap reached");
    imageCalls++;
    const t0 = Date.now();
    const r = await realImage.generate(req);
    imageRaw = r.ok ? { ok: true, ms: Date.now() - t0, costUsd: r.telemetry.costUsd } : { ok: false, ms: Date.now() - t0, error: `[${r.error.code}] ${r.error.message}` };
    return r;
  },
};

mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const r = await prepareNewRound({
  seed, generate: counted, generator: createLlmOpinionGenerator(counted), checker: createLlmChecker(counted), imageGenerator,
  maxScenarioAttempts: 1, imageRetries: 0, fallbackToPrepared: false, checkerRetries: 0, saveImagesTo: outDir,
});
const wall = Date.now() - t0;
// Raw replies are saved to the git-ignored output folder. The dump holds no image bytes and no API keys.
const dumpPath = join(outDir, `full-generation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const dump = { seed, ok: r.ok, calls, image: imageRaw, result: r.ok ? { publicCase: r.publicCase, scenario: r.scenario, server: r.server } : r };
writeFileSync(dumpPath, JSON.stringify(dump, null, 2));

console.log(`\n${"=".repeat(88)}`);
if (!r.ok) {
  console.log(`RESULT: FAILED at stage "${r.stage}": ${r.message}`);
  for (const a of r.attempts) console.log(`  attempt ${a.attempt} stage ${a.stage} ok ${a.ok} ${a.message ?? ""}`);
  if (r.preserved) console.log(`  Scenario and opinions DID succeed ("${r.preserved.scenario.title}"); only the image failed: ${r.preserved.imageError.message}`);
  const cs = calls.find((c) => c.kind === "scenario");
  if (cs?.raw && !r.preserved) console.log(`  scenario raw reply (first 1500 chars): ${cs.raw.slice(0, 1500)}`);
} else {
  const s = r.server;
  console.log(`PUBLIC SCENARIO [${r.publicCase.scenarioId}] "${r.publicCase.title}"\n${r.publicCase.description}\nEvidence:`);
  for (const e of r.publicCase.evidence) console.log(`  ${e.id}: ${e.text}`);
  console.log("\nPRIVATE DESIGN (server-only quality-control data, printed here for the benchmark only)");
  console.log(`  hints: ${s.design?.hint.situation} / ${s.design?.hint.setting}; model's setting: ${s.design?.setting}`);
  for (const d of s.design?.designs ?? []) console.log(`  - ${d.label}: ${d.mechanism}`);
  console.log(`\nIMAGE: ${r.publicCase.localImagePath} | ${r.image?.mimeType}, ${r.image?.byteLength} bytes | model ${s.models.image}`);
  console.log(`  image prompt: ${r.image?.prompt.replace(/\n/g, " ").slice(0, 400)}`);
  const o = s.opinions;
  const a = analyseRun({ seed, personalities: o.personalities, generated: o.generated, checkerOrder: o.checkerOrder, checkerReport: o.checkerReport }, o.selection.diagnostics);
  console.log(`\nOPINIONS AND CHECKER\n${a.lines.join("\n")}\nSIGNALS: ${JSON.stringify(a.signals)}`);
  console.log(`\nSELECTED: A=${o.locked.A} "${o.selection.a.title}"\n   ${r.scenario.interpretationA}\n          B=${o.locked.B} "${o.selection.b.title}"\n   ${r.scenario.interpretationB}`);
  writeFileSync(join(outDir, `${r.publicCase.scenarioId}.public.json`), JSON.stringify({ ...r.publicCase, scenario: r.scenario }, null, 2));
}

const estClaude = calls.reduce((sum, c) => sum + ((c.inputTokens ?? 0) * PRICE.input + (c.outputTokens ?? 0) * PRICE.output) / 1e6, 0);
console.log("\nMEASURED TIMES (ms)");
for (const c of calls) console.log(`  ${c.kind}: ${c.ms}${c.error ? ` FAILED ${c.error}` : ""}  tokens in/out ${c.inputTokens ?? "?"}/${c.outputTokens ?? "?"}`);
if (imageRaw) console.log(`  image: ${imageRaw.ms}${imageRaw.ok ? "" : ` FAILED ${imageRaw.error}`}`);
if (r.ok) console.log(`  scenario ${r.server.timing.scenarioMs} | parallel stage ${r.server.timing.parallelMs} (image ${r.server.timing.imageMs}, opinions ${r.server.timing.opinionsMs})`);
console.log(`  TOTAL WALL CLOCK: ${wall} ms`);
console.log("COST");
console.log(`  Claude: ESTIMATED $${estClaude.toFixed(4)} (token counts x assumed $2/$10 per million; not a provider charge)`);
console.log(`  Image: ${imageRaw?.costUsd !== undefined ? `ACTUAL, reported by OpenRouter: $${imageRaw.costUsd}` : "the provider reported no cost"}`);
console.log(`Requests sent: Claude ${claude}/${CLAUDE_CAP}, image ${imageCalls}/${IMAGE_CAP}`);
console.log(`Saved (git-ignored): ${dumpPath}`);
