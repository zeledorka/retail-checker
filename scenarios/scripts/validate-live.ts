// LIVE (billed) controlled validation of the independent opinion ranking.
// Hard cap: 6 paid requests = 3 runs x 2 agents (A and B in parallel). One ranking attempt per run, no retries,
// no pool fallback, no scenario generator, no images.
//   cd scenarios && npx tsx scripts/validate-live.ts --env-file=/path/to/ai/.env
import { generateText } from "../../ai/src/index";
import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { DEFAULT_MIN_STRENGTH, PREPARED_CASES, RANKER_MODEL, createLlmRanker, describePersonality, generatePersonality, prepareRound, validateRanking } from "../src/index";
import type { PrepareResult, RawRankingItem, Side } from "../src/index";

const envFile = process.argv.find((a) => a.startsWith("--env-file="))?.split("=")[1];
if (envFile) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (use --env-file=...)");
  process.exit(1);
}

const PAID_REQUEST_CAP = 6;
const PRICE = { input: 2, output: 10 }; // USD per million tokens (Sonnet 5.5); an estimate, not a provider-confirmed charge
const RUNS = [
  { scenario: PREPARED_CASES[0], seed: 101 },
  { scenario: PREPARED_CASES[0], seed: 202 },
  { scenario: PREPARED_CASES[1], seed: 303 },
];

type Call = { side: Side; ms: number; inputTokens?: number; outputTokens?: number; raw?: string; error?: string };
let paid = 0;

/** Wraps the real provider call: enforces the cap, records latency, usage and the raw reply per side. */
function instrumented(seed: number, calls: Call[]): GenerateTextFn {
  const text = { A: describePersonality(generatePersonality(seed, "A")), B: describePersonality(generatePersonality(seed, "B")) };
  return async (cfg, req) => {
    if (paid >= PAID_REQUEST_CAP) throw new Error(`paid request cap ${PAID_REQUEST_CAP} reached`);
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

const f = (n: number) => n.toFixed(2);
const traits = (p: ReturnType<typeof generatePersonality>) =>
  `scepticism ${f(p.evidenceScepticism)} | inference ${f(p.inferenceWillingness)} | risk ${f(p.riskTolerance)} | simplicity ${f(p.simplicityPreference)} | directness ${f(p.directness)} | flourish ${f(p.rhetoricalFlourish)} | aggression ${f(p.rebuttalAggression)}`;

type Row = { run: number; scenario: string; seed: number; firstA: string; firstB: string; copyA: boolean; copyB: boolean; outcome: string };
const rows: Row[] = [];
let totalIn = 0;
let totalOut = 0;
let totalWall = 0;

for (const [n, run] of RUNS.entries()) {
  const calls: Call[] = [];
  const t0 = Date.now();
  const result: PrepareResult = await prepareRound({ scenarioCase: run.scenario, seed: run.seed, ranker: createLlmRanker(instrumented(run.seed, calls), RANKER_MODEL) });
  const wall = Date.now() - t0;
  totalWall += wall;
  const ids = run.scenario.interpretations.map((i) => i.id);
  const labelOf = (id: string) => run.scenario.interpretations.find((i) => i.id === id)?.label ?? id;

  console.log(`\n${"=".repeat(88)}`);
  console.log(`RUN ${n + 1}: "${run.scenario.title}" (${run.scenario.id}) | seed ${run.seed} | ${RANKER_MODEL.model}, effort ${RANKER_MODEL.effort}`);
  console.log(`Candidates in the order shown to both agents: ${ids.map((id, k) => `${k + 1}.${id}`).join("  ")}`);
  for (const side of ["A", "B"] as Side[]) console.log(`Agent ${side} personality: ${traits(generatePersonality(run.seed, side))}`);

  const parsed: Record<Side, RawRankingItem[] | undefined> = { A: undefined, B: undefined };
  for (const side of ["A", "B"] as Side[]) {
    const call = calls.find((c) => c.side === side);
    console.log(`\nAgent ${side} ranking (${call ? `${call.ms} ms, tokens in/out ${call.inputTokens ?? "?"}/${call.outputTokens ?? "?"}` : "no call"}):`);
    if (!call || call.error) console.log(`  REQUEST FAILED: ${call?.error ?? "no call recorded"}`);
    let items: unknown;
    const m = call?.raw ? /\{[\s\S]*\}/.exec(call.raw)?.[0] : undefined;
    try {
      items = m ? (JSON.parse(m) as { ranking?: unknown }).ranking : undefined;
    } catch {
      items = undefined;
    }
    const v = validateRanking(items, new Set(ids));
    if (v.ok) {
      parsed[side] = v.items;
      for (const it of v.items) console.log(`  #${it.rank} ${it.id} (${labelOf(it.id)})  defensibility ${it.defensibility}/100\n      "${it.explanation}"`);
    } else console.log(`  VALIDATION ERRORS: ${v.errors.join("; ")}\n  raw reply: ${(call?.raw ?? "(none)").slice(0, 500)}`);
    totalIn += call?.inputTokens ?? 0;
    totalOut += call?.outputTokens ?? 0;
  }

  const runIn = calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
  const runOut = calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0);
  console.log(`\nLatency: A ${calls.find((c) => c.side === "A")?.ms ?? 0} ms | B ${calls.find((c) => c.side === "B")?.ms ?? 0} ms | combined wall-clock (parallel) ${wall} ms`);
  console.log(`Tokens in/out: ${runIn}/${runOut} | estimated cost $${((runIn * PRICE.input + runOut * PRICE.output) / 1e6).toFixed(4)} (estimate at $${PRICE.input}/$${PRICE.output} per MTok)`);

  const copiesOrder = (r?: RawRankingItem[]) => !!r && r.every((x, k) => ids.indexOf(x.id) === k);
  let outcome: string;
  if (result.ok) {
    const s = result.meta.selection;
    const defensible = s.chosen.defensibilityA >= DEFAULT_MIN_STRENGTH && s.chosen.defensibilityB >= DEFAULT_MIN_STRENGTH;
    outcome = `${s.a.id} vs ${s.b.id}`;
    console.log(`\nSELECTED  Agent A: [${s.a.id}] ${s.a.label}   |   Agent B: [${s.b.id}] ${s.b.label}`);
    console.log(`  A got its first preference: ${s.chosen.rankA === 1 ? "YES" : `no (its rank ${s.chosen.rankA})`} | B got its first preference: ${s.chosen.rankB === 1 ? "YES" : `no (its rank ${s.chosen.rankB})`}`);
    console.log(`  distinct: ${s.a.id !== s.b.id ? "yes" : "NO"} | both defensible (>= ${DEFAULT_MIN_STRENGTH}): ${defensible ? "yes" : "NO"} | pair score ${s.chosen.score} | valid pairs ${s.diagnostics.pairsValid}/${s.diagnostics.pairsConsidered} | tied ${s.diagnostics.tiedPairs}`);
    console.log(`  startRound scenario.interpretationA = "${result.scenario.interpretationA}"`);
    console.log(`  startRound scenario.interpretationB = "${result.scenario.interpretationB}"`);
  } else {
    outcome = `FAILED(${result.stage})`;
    console.log(`\nPREPARATION FAILED at stage "${result.stage}": ${result.message}`);
    if (result.selection && !result.selection.ok) console.log(`  selection errors: ${result.selection.errors.join("; ")}\n  diagnostics: ${JSON.stringify(result.selection.diagnostics ?? {})}`);
  }
  rows.push({ run: n + 1, scenario: run.scenario.id, seed: run.seed, firstA: parsed.A?.[0]?.id ?? "-", firstB: parsed.B?.[0]?.id ?? "-", copyA: copiesOrder(parsed.A), copyB: copiesOrder(parsed.B), outcome });
}

console.log(`\n${"=".repeat(88)}\nSUMMARY: ${paid} paid requests of ${PAID_REQUEST_CAP} allowed`);
console.log("run | scenario | seed | A first choice | B first choice | A = listing order? | B = listing order? | outcome");
for (const r of rows) console.log(`${r.run} | ${r.scenario} | ${r.seed} | ${r.firstA} | ${r.firstB} | ${r.copyA ? "YES" : "no"} | ${r.copyB ? "YES" : "no"} | ${r.outcome}`);
console.log(`Total tokens in/out ${totalIn}/${totalOut} | estimated total cost $${((totalIn * PRICE.input + totalOut * PRICE.output) / 1e6).toFixed(4)} | summed run wall-clock ${totalWall} ms`);
