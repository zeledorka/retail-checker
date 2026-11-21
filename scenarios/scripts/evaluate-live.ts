// LIVE (billed) evaluation of the independent opinion ranking, second round. NOT executed by the test suite.
// Plan (src/evaluation.ts): 6 runs x 2 parallel Claude Sonnet 5.5 ranking requests = 12 paid requests, one attempt per run,
// no retries, no pool fallback, no scenario generator, no images. Candidate listing order is shuffled per run (same order for
// both agents) so position bias can be measured.
//
//   npx tsx scripts/evaluate-live.ts                       -> prints the plan and the cost estimate, makes NO request
//   npx tsx scripts/evaluate-live.ts --approved --env-file=/path/to/ai/.env   -> runs it (only after explicit approval)
import { generateText } from "../../ai/src/index";
import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { DEFAULT_MIN_STRENGTH, PREPARED_CASES, RANKER_MODEL, createLlmRanker, describePersonality, generatePersonality, prepareRound, validateRanking } from "../src/index";
import type { PrepareResult, RawRankingItem, ScenarioCase, Side } from "../src/index";
import { EVAL_PLAN, EVAL_REQUEST_CAP, copiesListingOrder, firstChoicePosition, kendallTau, personalityDistance, shuffled } from "../src/evaluation";

const PRICE = { input: 2, output: 10 }; // USD per million tokens (Sonnet 5.5); an estimate, not a provider-confirmed charge
const approved = process.argv.includes("--approved");
const envFile = process.argv.find((a) => a.startsWith("--env-file="))?.split("=")[1];

console.log(`Plan: ${EVAL_PLAN.length} runs, ${EVAL_REQUEST_CAP} paid requests (${RANKER_MODEL.model}, effort ${RANKER_MODEL.effort}), minStrength ${DEFAULT_MIN_STRENGTH}`);
for (const p of EVAL_PLAN) console.log(`  - ${p.caseId} | seed ${p.seed}`);
console.log(`Estimated cost: about $${(EVAL_REQUEST_CAP * 0.0049).toFixed(2)} (the first live run cost $0.0048 per request; estimate only)`);
if (!approved) {
  console.log("\nNOT RUN: no --approved flag, so no request was made.");
  process.exit(0);
}
if (envFile) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (use --env-file=...)");
  process.exit(1);
}

type Call = { side: Side; ms: number; inputTokens?: number; outputTokens?: number; raw?: string; error?: string };
let paid = 0;
function instrumented(seed: number, calls: Call[]): GenerateTextFn {
  const text = { A: describePersonality(generatePersonality(seed, "A")), B: describePersonality(generatePersonality(seed, "B")) };
  return async (cfg, req) => {
    if (paid >= EVAL_REQUEST_CAP) throw new Error(`paid request cap ${EVAL_REQUEST_CAP} reached`);
    paid++;
    const side: Side = req.prompt.includes(text.A) ? "A" : "B";
    const t0 = Date.now();
    const out: GenerateOutcome = await generateText(cfg, req);
    const ms = Date.now() - t0;
    if (out.ok) calls.push({ side, ms, inputTokens: out.result.inputTokens, outputTokens: out.result.outputTokens, raw: out.result.text });
    else calls.push({ side, ms, inputTokens: out.error.inputTokens, outputTokens: out.error.outputTokens, error: `[${out.error.kind}] ${out.error.message}`, raw: out.error.partialText });
    return out;
  };
}

const f2 = (n: number) => n.toFixed(2);
const traits = (p: ReturnType<typeof generatePersonality>) => `scepticism ${f2(p.evidenceScepticism)} | inference ${f2(p.inferenceWillingness)} | risk ${f2(p.riskTolerance)} | simplicity ${f2(p.simplicityPreference)} | directness ${f2(p.directness)} | flourish ${f2(p.rhetoricalFlourish)} | aggression ${f2(p.rebuttalAggression)}`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function pearson(x: number[], y: number[]): number | undefined {
  if (x.length < 3) return undefined;
  const mx = mean(x), my = mean(y);
  const num = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const den = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
  return den ? num / den : undefined;
}

type Row = { run: number; caseId: string; seed: number; ok: boolean; firstA?: string; firstB?: string; sameFirst: boolean; tau?: number; dist: number; posA: number; posB: number; copyA: boolean; copyB: boolean; scores: number[]; wall: number; in: number; out: number; selection: string };
const rows: Row[] = [];

for (const [n, plan] of EVAL_PLAN.entries()) {
  const base = PREPARED_CASES.find((c) => c.id === plan.caseId) as ScenarioCase;
  const scenarioCase: ScenarioCase = { ...base, interpretations: shuffled(base.interpretations, plan.seed) }; // same order for both agents
  const listing = scenarioCase.interpretations.map((i) => i.id);
  const calls: Call[] = [];
  const t0 = Date.now();
  const result: PrepareResult = await prepareRound({ scenarioCase, seed: plan.seed, ranker: createLlmRanker(instrumented(plan.seed, calls), RANKER_MODEL) });
  const wall = Date.now() - t0;
  const pA = generatePersonality(plan.seed, "A");
  const pB = generatePersonality(plan.seed, "B");
  console.log(`\n${"=".repeat(88)}\nRUN ${n + 1}: "${base.title}" | seed ${plan.seed}\nListing order shown to both agents: ${listing.map((id, k) => `${k + 1}.${id}`).join("  ")}`);
  console.log(`Agent A: ${traits(pA)}\nAgent B: ${traits(pB)}`);
  const parsed: Partial<Record<Side, RawRankingItem[]>> = {};
  for (const side of ["A", "B"] as Side[]) {
    const call = calls.find((c) => c.side === side);
    console.log(`\nAgent ${side} (${call?.ms ?? "?"} ms, tokens in/out ${call?.inputTokens ?? "?"}/${call?.outputTokens ?? "?"}):`);
    if (!call || call.error) console.log(`  REQUEST FAILED: ${call?.error ?? "no call"}`);
    let items: unknown;
    const m = call?.raw ? /\{[\s\S]*\}/.exec(call.raw)?.[0] : undefined;
    try {
      items = m ? (JSON.parse(m) as { ranking?: unknown }).ranking : undefined;
    } catch {
      items = undefined;
    }
    const v = validateRanking(items, new Set(listing));
    if (v.ok) {
      parsed[side] = v.items;
      for (const it of v.items) console.log(`  #${it.rank} ${it.id} (listing position ${listing.indexOf(it.id) + 1})  defensibility ${it.defensibility}/100\n      "${it.explanation}"`);
    } else console.log(`  VALIDATION ERRORS: ${v.errors.join("; ")}\n  raw: ${(call?.raw ?? "").slice(0, 400)}`);
  }
  const rIn = calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
  const rOut = calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0);
  console.log(`\nLatency: A ${calls.find((c) => c.side === "A")?.ms} ms | B ${calls.find((c) => c.side === "B")?.ms} ms | combined (parallel) ${wall} ms | tokens ${rIn}/${rOut} | est. $${((rIn * PRICE.input + rOut * PRICE.output) / 1e6).toFixed(4)}`);
  let selection: string;
  if (result.ok) {
    const s = result.meta.selection;
    selection = `${s.a.id} vs ${s.b.id}`;
    console.log(`SELECTED A: [${s.a.id}] ${s.a.label} (its rank ${s.chosen.rankA}, ${s.chosen.defensibilityA}/100) | B: [${s.b.id}] ${s.b.label} (its rank ${s.chosen.rankB}, ${s.chosen.defensibilityB}/100)`);
    console.log(`  first preference: A ${s.chosen.rankA === 1 ? "YES" : "no"}, B ${s.chosen.rankB === 1 ? "YES" : "no"} | distinct ${s.a.id !== s.b.id ? "yes" : "NO"} | both >= ${DEFAULT_MIN_STRENGTH}: ${s.chosen.defensibilityA >= DEFAULT_MIN_STRENGTH && s.chosen.defensibilityB >= DEFAULT_MIN_STRENGTH ? "yes" : "no (allowed: default minimum is lower)"}`);
  } else {
    selection = `FAILED(${result.stage})`;
    console.log(`PREPARATION FAILED at "${result.stage}": ${result.message}`);
  }
  const ra = parsed.A ?? [];
  const rb = parsed.B ?? [];
  rows.push({
    run: n + 1, caseId: plan.caseId, seed: plan.seed, ok: result.ok, firstA: ra[0]?.id, firstB: rb[0]?.id, sameFirst: !!ra[0] && ra[0]?.id === rb[0]?.id,
    tau: kendallTau(ra.map((x) => x.id), rb.map((x) => x.id)), dist: personalityDistance(pA, pB), posA: firstChoicePosition(listing, ra), posB: firstChoicePosition(listing, rb),
    copyA: copiesListingOrder(listing, ra), copyB: copiesListingOrder(listing, rb), scores: [...ra, ...rb].map((x) => x.defensibility), wall, in: rIn, out: rOut, selection,
  });
}

const all = rows.flatMap((r) => r.scores);
console.log(`\n${"=".repeat(88)}\nSUMMARY (${paid} paid requests of ${EVAL_REQUEST_CAP})`);
console.log("run | case | seed | A first | B first | same first? | tau(A,B) | trait distance | first-choice listing pos A/B | order copy A/B | selection");
for (const r of rows) console.log(`${r.run} | ${r.caseId} | ${r.seed} | ${r.firstA} | ${r.firstB} | ${r.sameFirst ? "YES" : "no"} | ${r.tau === undefined ? "n/a" : f2(r.tau)} | ${f2(r.dist)} | ${r.posA + 1}/${r.posB + 1} | ${r.copyA ? "YES" : "no"}/${r.copyB ? "YES" : "no"} | ${r.selection}`);
const success = rows.filter((r) => r.ok).length;
console.log(`Selection success: ${success}/${rows.length} | A and B chose the same first interpretation in ${rows.filter((r) => r.sameFirst).length}/${rows.length} runs`);
console.log(`Defensibility scores (${all.length}): mean ${mean(all).toFixed(1)}, min ${Math.min(...all)}, max ${Math.max(...all)}, >= 60: ${all.filter((s) => s >= 60).length}, >= ${DEFAULT_MIN_STRENGTH}: ${all.filter((s) => s >= DEFAULT_MIN_STRENGTH).length}`);
const positions = [0, 0, 0, 0];
for (const r of rows) for (const p of [r.posA, r.posB]) if (p >= 0) positions[p]++;
console.log(`First choice by listing position (1st..4th): ${positions.join(" / ")} of ${positions.reduce((a, b) => a + b, 0)} rankings (about equal = no position bias) | rankings that simply copy the listing order: ${rows.filter((r) => r.copyA).length + rows.filter((r) => r.copyB).length}`);
const withTau = rows.filter((r) => r.tau !== undefined);
const corr = pearson(withTau.map((r) => r.dist), withTau.map((r) => r.tau as number));
console.log(`Personality influence: correlation between the A/B evidence-weighing trait distance and their ranking agreement (tau) = ${corr === undefined ? "n/a" : f2(corr)} over ${withTau.length} runs (negative = more different personalities, less agreement; very noisy with so few runs)`);
const tin = rows.reduce((s, r) => s + r.in, 0);
const tout = rows.reduce((s, r) => s + r.out, 0);
console.log(`Latency per run (parallel pair): mean ${Math.round(mean(rows.map((r) => r.wall)))} ms | total tokens ${tin}/${tout} | estimated total cost $${((tin * PRICE.input + tout * PRICE.output) / 1e6).toFixed(4)}`);
