// Mocked pre-round preparation, end to end: no network, no key, no cost. Run: npm run example:mock
//   seed -> case -> two independent personalities -> two parallel rankings -> deterministic selection -> locked scenario
//   -> startRound() of the AI module (what Developer 3 calls next).
import { startRound } from "../../ai/src/index";
import { PREPARED_CASES, createSeededMockRanker, newSeed, prepareFromPool } from "../src/index";

export async function runMockPreparation(seed: number = newSeed()) {
  const ranker = createSeededMockRanker(); // the live ranker is createLlmRanker(generateText) and is not run here
  const prepared = await prepareFromPool({ cases: PREPARED_CASES, seed, ranker });
  if (!prepared.ok) return { ok: false as const, seed, failures: prepared.failures };
  const { scenario, meta, publicScenario } = prepared.result;
  const round = startRound({ roundId: `mock-room:${seed}`, scenario }); // exactly the AI module's input
  return { ok: true as const, seed, scenario, publicScenario, meta, round, modelRequests: ranker.requests.length };
}

if (process.argv[1]?.endsWith("mock-preparation.ts")) {
  const r = await runMockPreparation();
  if (!r.ok) console.log("no credible pair in the attempted cases:", r.failures.map((f) => `${f.scenarioId}: ${f.message}`));
  else {
    console.log(`seed ${r.seed} | case ${r.meta.scenarioId} | requests: ${r.modelRequests} (two per attempt, made in parallel)`);
    console.log(`Agent A defends [${r.meta.locked.A}]: ${r.scenario.interpretationA}`);
    console.log(`Agent B defends [${r.meta.locked.B}]: ${r.scenario.interpretationB}`);
    console.log(`selection score ${r.meta.selection.chosen.score} (ranks A${r.meta.selection.chosen.rankA}/B${r.meta.selection.chosen.rankB}); ${r.meta.selection.diagnostics.pairsValid} valid pairs of ${r.meta.selection.diagnostics.pairsConsidered}`);
    console.log(`startRound accepted it: ${r.round.ok}`);
  }
}
