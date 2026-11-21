import { anonymise } from "./checker";
import { selectFinalPair } from "./opinion-selector";
import { distinctExplanations } from "./opinion-diagnostics";
import { generatePersonality } from "./personality";
import { validateScenarioInput } from "./scenario-input";
import type { CallTelemetry, CheckResult, FinalSelectionOptions, OpinionChecker, OpinionGenerator, OpinionPrepareResult, ScenarioInput, StageError } from "./opinion-types";
import type { Side } from "./types";

const SIDES: Side[] = ["A", "B"];

/**
 * Pre-round preparation by independent opinion generation. Normal successful path = THREE model requests:
 *   1. Agent A and Agent B each write three interpretations (two requests, in parallel; same scenario and evidence, each with its
 *      own random personality; neither sees the other's output; no candidate list is supplied);
 *   2. one independent checker request over the six opinions (anonymous ids, seeded shuffled order, no sides, personalities,
 *      ranks or self-scores);
 *   3. the deterministic final selection, locally (no request).
 * Recovery: if the checker's reply fails validation (invalid_output) it is requested once more (`checkerRetries`, default 1);
 * a provider error is NOT retried. No retry is made for generation. The result's `meta.llmCalls` says how many requests were sent.
 * `scenario` is exactly the input of `startRound` (ai/src/round.ts); `meta` is server-only.
 */
export async function prepareScenario(input: {
  scenario: ScenarioInput;
  seed: number;
  generator: OpinionGenerator;
  checker: OpinionChecker;
  selection?: Partial<Omit<FinalSelectionOptions, "seed">>;
  /** Extra checker requests allowed after an invalid reply. Default 1. */
  checkerRetries?: number;
  /** Seed for the checker's shuffled order (default: the round seed). Exposed to test order-sensitivity. */
  checkerOrderSeed?: number;
}): Promise<OpinionPrepareResult> {
  const checked = validateScenarioInput(input.scenario);
  if (!checked.ok) return { ok: false, stage: "input", scenarioId: String(input.scenario?.id), message: checked.errors.join("; "), llmCalls: 0 };
  const scenario = checked.value;
  const personalities = { A: generatePersonality(input.seed, "A"), B: generatePersonality(input.seed, "B") };
  let calls = 0;

  // 1. independent generation, in parallel
  calls += 2;
  const [ga, gb] = await Promise.all(SIDES.map((side) => input.generator.generate({ side, scenario, personality: personalities[side] })));
  for (const [side, g] of [["A", ga], ["B", gb]] as const)
    if (!g.ok) return { ok: false, stage: "generation", scenarioId: scenario.id, message: g.error.code === "insufficient_diversity" ? `Agent ${side} found fewer than three distinct defensible interpretations: ${g.error.message}` : `Agent ${side}'s opinion generation failed: ${g.error.message}`, error: g.error, partial: { seed: input.seed, personalities }, llmCalls: calls };
  if (!ga.ok || !gb.ok) throw new Error("unreachable");
  const generated = { A: ga.opinions, B: gb.opinions };

  // 2. one independent check over the six opinions, anonymised and shuffled
  const { checkerOpinions, order } = anonymise([...generated.A, ...generated.B], input.checkerOrderSeed ?? input.seed);
  let check: CheckResult | undefined;
  for (let attempt = 0; attempt <= (input.checkerRetries ?? 1); attempt++) {
    calls++;
    check = await input.checker.check({ scenario, opinions: checkerOpinions });
    if (check.ok || check.error.code !== "invalid_output") break; // only a validation failure justifies another request
  }
  if (!check || !check.ok) {
    const error: StageError = check?.ok === false ? check.error : { code: "model_error", message: "no checker result", retryable: true };
    return { ok: false, stage: "checker", scenarioId: scenario.id, message: `the independent checker failed: ${error.message}`, error, partial: { seed: input.seed, personalities, generated, checkerOrder: order }, llmCalls: calls };
  }

  // 3. deterministic selection with the hidden mapping restored
  const selection = selectFinalPair({ opinionsA: generated.A, opinionsB: generated.B, checkerOrder: order, report: check.report }, { ...input.selection, seed: input.seed });
  if (!selection.ok) return { ok: false, stage: "selection", scenarioId: scenario.id, message: selection.message, selection, partial: { seed: input.seed, personalities, generated, checkerOrder: order, checkerReport: check.report }, llmCalls: calls };

  const texts = scenario.evidence.map((e) => e.text);
  const interpretationA = selection.a.explanation;
  const interpretationB = selection.b.explanation;
  return {
    ok: true,
    scenario: { title: scenario.title, description: scenario.description, evidence: texts, interpretationA, interpretationB },
    publicScenario: { title: scenario.title, description: scenario.description, evidence: texts, interpretationA, interpretationB, ...(scenario.imagePath ? { imagePath: scenario.imagePath } : {}) },
    meta: {
      scenarioId: scenario.id,
      seed: input.seed,
      personalities,
      generated,
      checkerOrder: order,
      checkerReport: check.report,
      diversity: { A: distinctExplanations(generated.A, order, check.report), B: distinctExplanations(generated.B, order, check.report) },
      selection,
      locked: { A: selection.a.id, B: selection.b.id },
      telemetry: { generation: { A: ga.telemetry as CallTelemetry | undefined, B: gb.telemetry as CallTelemetry | undefined }, checker: check.telemetry },
      llmCalls: calls,
    },
  };
}
