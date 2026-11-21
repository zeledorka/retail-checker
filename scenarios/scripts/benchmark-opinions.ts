// LIVE (billed) benchmark of the independent opinion-generation pipeline. NOT executed by the test suite.
// Default plan: 2 scenarios x (2 parallel generation requests + 1 checker request) = 6 paid Sonnet 5.5 requests, no retries.
//
//   npx tsx scripts/benchmark-opinions.ts                                   -> prints the plan and cost estimate, makes NO request
//   npx tsx scripts/benchmark-opinions.ts --approved --env-file=<ai/.env>   -> runs the 6 requests (only after explicit approval)
//   add --approve-recheck                                                   -> ALSO repeats the checker once per scenario with a
//        different shuffled order (+2 paid requests, a separately approved experiment on checker order sensitivity)
// Options: --cases=empty-display-case,silent-call   --seed=<int> (first seed; second case uses seed+1)
import { generateText } from "../../ai/src/index";
import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { writeFileSync } from "node:fs";
import { CHECKER_MODEL, CHECKER_SYSTEM, OPINION_MODEL, OPINION_SYSTEM, PREPARED_SCENARIOS, analyseRun, anonymise, createLlmChecker, createLlmOpinionGenerator, prepareScenario, selectFinalPair } from "../src/index";
import type { CheckerReport, OpinionPrepareResult } from "../src/index";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const approved = process.argv.includes("--approved");
const recheck = process.argv.includes("--approve-recheck");
const caseIds = (arg("cases") ?? "empty-display-case,silent-call").split(",");
const seed0 = Number(arg("seed") ?? 2026);
const PRICE = { input: 2, output: 10 }; // USD per million tokens (Sonnet 5.5): an estimate, not a provider-confirmed charge
const CAP = 6 + (recheck ? 2 : 0);

if (caseIds.length !== 2 || caseIds.some((id) => !PREPARED_SCENARIOS.some((s) => s.id === id)) || !Number.isInteger(seed0)) {
  console.error("Exactly two known case ids are required (--cases=a,b) and --seed must be an integer. No request was made.");
  process.exit(1);
}
console.log(`Plan: ${caseIds.length} scenarios, ${CAP} paid requests max (${OPINION_MODEL.model}, effort ${OPINION_MODEL.effort}; maxRetries 0, no fallback)`);
caseIds.forEach((id, k) => console.log(`  - ${id} | seed ${seed0 + k} | 2 generation + 1 checker${recheck ? " + 1 re-check (different order)" : ""}`));
console.log(`Estimated cost: about $${(CAP * 0.012).toFixed(2)} (rough estimate; the checker request is the largest)`);
if (!approved) {
  console.log("\nNOT RUN: no --approved flag, so no request was made.");
  process.exit(0);
}
const envFile = arg("env-file");
if (envFile) process.loadEnvFile(envFile);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (use --env-file=...)");
  process.exit(1);
}

type Call = { kind: "generation" | "checker"; ms: number; inputTokens?: number; outputTokens?: number; error?: string; raw?: string };
let paid = 0;
const log: Call[] = [];
const counted: GenerateTextFn = async (cfg, req) => {
  if (paid >= CAP) throw new Error(`paid request cap ${CAP} reached`);
  paid++;
  const t0 = Date.now();
  const out: GenerateOutcome = await generateText(cfg, req);
  const ms = Date.now() - t0;
  const kind = req.system === CHECKER_SYSTEM ? "checker" : req.system === OPINION_SYSTEM ? "generation" : undefined;
  if (!kind) throw new Error("unexpected request");
  log.push(out.ok ? { kind, ms, inputTokens: out.result.inputTokens, outputTokens: out.result.outputTokens, raw: out.result.text } : { kind, ms, inputTokens: out.error.inputTokens, outputTokens: out.error.outputTokens, error: `[${out.error.kind}] ${out.error.message}`, raw: out.error.partialText });
  return out;
};
const cost = (cs: Call[]) => cs.reduce((s, c) => s + ((c.inputTokens ?? 0) * PRICE.input + (c.outputTokens ?? 0) * PRICE.output) / 1e6, 0);
const generator = createLlmOpinionGenerator(counted, OPINION_MODEL);
const checker = createLlmChecker(counted, CHECKER_MODEL);

function printReport(title: string, anonOf: Map<string, string>, report: CheckerReport, byAnon: Map<string, string>) {
  console.log(`\n${title}`);
  for (const a of [...report.assessments].sort((x, y) => x.id.localeCompare(y.id))) console.log(`  ${a.id} (${byAnon.get(a.id)}) defensibility ${a.defensibility} [${a.flag}] ${a.note}`);
  console.log(`  equivalence groups: ${report.equivalenceGroups.length ? report.equivalenceGroups.map((g) => `{${g.map((id) => `${id}=${byAnon.get(id)}`).join(", ")}}`).join(" ") : "none"}`);
  console.log("  pairs (difference / meaningful):");
  for (const p of report.pairs) console.log(`    ${p.a}(${byAnon.get(p.a)}) vs ${p.b}(${byAnon.get(p.b)}): ${p.difference} / ${p.meaningful}`);
  void anonOf;
}

const summary: string[] = [];
const dumps: unknown[] = [];
for (const [k, id] of caseIds.entries()) {
  const scenario = PREPARED_SCENARIOS.find((s) => s.id === id)!;
  const seed = seed0 + k;
  const before = log.length;
  const t0 = Date.now();
  const r: OpinionPrepareResult = await prepareScenario({ scenario, seed, generator, checker, checkerRetries: 0 });
  const wall = Date.now() - t0;
  console.log(`\n${"=".repeat(88)}\nSCENARIO "${scenario.title}" | seed ${seed} | wall ${wall} ms | requests ${log.length - before}`);
  for (const c of log.slice(before)) console.log(`  ${c.kind}: ${c.ms} ms, tokens in/out ${c.inputTokens ?? "?"}/${c.outputTokens ?? "?"}${c.error ? ` ERROR ${c.error}` : ""}`);
  // Full diagnostics on success AND failure; raw replies are saved to validation/ so nothing is lost.
  const partial = r.ok ? { seed, personalities: r.meta.personalities, generated: r.meta.generated, checkerOrder: r.meta.checkerOrder, checkerReport: r.meta.checkerReport } : r.partial;
  const selDiag = r.ok ? r.meta.selection.diagnostics : r.selection?.diagnostics;
  if (!r.ok) {
    console.log(`RESULT: FAILED at ${r.stage}: ${r.message}`);
    if (r.error?.details) console.log(`  details: ${r.error.details.slice(0, 8).join(" | ")}`);
    if (r.error?.raw) console.log(`  raw invalid reply (first 1500 chars): ${r.error.raw.slice(0, 1500)}`);
  }
  const analysis = partial ? analyseRun(partial, selDiag) : undefined;
  if (analysis) console.log(`\n${analysis.lines.join("\n")}\nSIGNALS: ${JSON.stringify(analysis.signals)}`);
  if (r.ok) console.log(`SELECTED: A=${r.meta.locked.A} "${r.meta.selection.a.title}"  vs  B=${r.meta.locked.B} "${r.meta.selection.b.title}"`);
  dumps.push({ scenario: id, seed, result: r.ok ? { ok: true, meta: r.meta } : { ok: false, stage: r.stage, message: r.message, error: r.error, partial: r.partial, selection: r.selection }, rawReplies: log.slice(before).map((c) => ({ kind: c.kind, ms: c.ms, inputTokens: c.inputTokens, outputTokens: c.outputTokens, error: c.error, raw: c.raw })) });
  summary.push(`${id}: ${r.ok ? `${r.meta.locked.A} vs ${r.meta.locked.B}` : `failed at ${r.stage}`}, ${wall} ms`);
  if (!r.ok && r.stage !== "selection") continue;
  if (!r.ok || !partial?.generated || !partial.checkerReport) continue;
  const m = r.ok ? r.meta : undefined;
  if (!m) continue;
  const byAnon = m ? new Map(m.checkerOrder.map((x) => [x.anonId, x.opinionId])) : new Map<string, string>();
  if (recheck) {
    const all = [...m.generated.A, ...m.generated.B];
    const { checkerOpinions, order } = anonymise(all, seed + 7919);
    const again = await checker.check({ scenario, opinions: checkerOpinions });
    const c = log[log.length - 1];
    console.log(`\nRE-CHECK with a different shuffled order: ${c.ms} ms, tokens in/out ${c.inputTokens ?? "?"}/${c.outputTokens ?? "?"}`);
    if (!again.ok) {
      console.log(`  RE-CHECK FAILED: ${again.error.message}`);
      continue;
    }
    const byAnon2 = new Map(order.map((x) => [x.anonId, x.opinionId]));
    printReport("Checker (order 2)", new Map(), again.report, byAnon2);
    const sel = selectFinalPair({ opinionsA: m.generated.A, opinionsB: m.generated.B, checkerOrder: order, report: again.report }, { seed });
    const score = (rep: CheckerReport, map: Map<string, string>) => new Map(rep.assessments.map((a) => [map.get(a.id)!, a.defensibility]));
    const s1 = score(m.checkerReport, byAnon);
    const s2 = score(again.report, byAnon2);
    const diffs = [...s1].map(([oid, v]) => Math.abs(v - (s2.get(oid) ?? NaN)));
    console.log(`  defensibility change per opinion (order 1 vs 2): ${[...s1].map(([oid, v]) => `${oid}:${v}->${s2.get(oid)}`).join(" ")} | mean abs ${(diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(1)}`);
    console.log(`  re-check selected: ${sel.ok ? `${sel.a.id} vs ${sel.b.id}` : "no credible pair"} | same pair as order 1: ${sel.ok && sel.a.id === m.locked.A && sel.b.id === m.locked.B}`);
  }
}
const dumpPath = new URL(`../validation/live-opinions-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(dumpPath, JSON.stringify({ plan: { caseIds, seed0, recheck }, dumps }, null, 2));
console.log(`\nFull raw replies and parsed results saved to ${dumpPath.pathname}`);
console.log(`\n${"=".repeat(88)}\nTOTAL paid requests: ${paid}/${CAP} | estimated cost $${cost(log).toFixed(4)} | tokens in ${log.reduce((s, c) => s + (c.inputTokens ?? 0), 0)} out ${log.reduce((s, c) => s + (c.outputTokens ?? 0), 0)}\n${summary.join("\n")}`);
