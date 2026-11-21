import { generatePersonality, hashSeed, mulberry32 } from "./personality";
import { validateScenarioCase } from "./schema";
import { selectOpinions } from "./selector";
import type { OpinionRanker, PrepareFailure, PrepareResult, ScenarioCase, SelectionOptions, Side } from "./types";

const SIDES: Side[] = ["A", "B"];

/**
 * Pre-round preparation for ONE case: validate -> two independent ranking requests IN PARALLEL (the only model calls) ->
 * deterministic selection (no model call) -> the locked scenario. Run it before the timed debate.
 *
 * `scenario` is exactly the input of `startRound({ roundId, scenario })` in ai/src/round.ts: the two locked interpretations are
 * the selected candidates' descriptions (Agent A defends `interpretationA`). `meta` is server-side: personalities, rankings and
 * diagnostics must not reach the judge or the frontend.
 */
export async function prepareRound(input: { scenarioCase: ScenarioCase; seed: number; ranker: OpinionRanker; selection?: Partial<Omit<SelectionOptions, "seed">> }): Promise<PrepareResult> {
  const checked = validateScenarioCase(input.scenarioCase);
  if (!checked.ok) return { ok: false, stage: "scenario", scenarioId: String(input.scenarioCase?.id), message: checked.errors.join("; ") };
  const c = checked.value;
  const personalities = { A: generatePersonality(input.seed, "A"), B: generatePersonality(input.seed, "B") };
  const shared = { title: c.title, description: c.description, evidence: c.evidence };
  // Each request carries the shared case, the shared candidates and ONLY its own personality.
  const [a, b] = await Promise.all(SIDES.map((side) => input.ranker.rank({ side, scenario: shared, candidates: c.interpretations, personality: personalities[side] })));
  for (const [side, r] of [["A", a], ["B", b]] as const)
    if (!r.ok) return { ok: false, stage: "ranking", scenarioId: c.id, message: `Agent ${side}'s opinion ranking failed: ${r.error.message}`, rankingError: r.error };
  if (!a.ok || !b.ok) throw new Error("unreachable");
  const selection = selectOpinions({ candidates: c.interpretations, rankingA: a.rankings, rankingB: b.rankings }, { ...input.selection, seed: input.seed });
  if (!selection.ok) return { ok: false, stage: "selection", scenarioId: c.id, message: `${selection.reason}: ${selection.errors.join("; ")}`, selection };
  return {
    ok: true,
    scenario: { title: c.title, description: c.description, evidence: c.evidence, interpretationA: selection.a.description, interpretationB: selection.b.description },
    publicScenario: { title: c.title, description: c.description, evidence: c.evidence, interpretationA: selection.a.description, interpretationB: selection.b.description, ...(c.imagePath ? { imagePath: c.imagePath } : {}) },
    meta: {
      scenarioId: c.id,
      seed: input.seed,
      personalities,
      candidates: c.interpretations,
      rankings: { A: a.rankings, B: b.rankings },
      selection,
      locked: { A: selection.a.id, B: selection.b.id },
      rankingTelemetry: { A: a.telemetry, B: b.telemetry },
    },
  };
}

/**
 * Picks prepared cases in a seeded random order until one yields a credible opposing pair. A failed attempt (ranking error or
 * no credible pair) costs two requests and moves on to the next case; nothing is forced. All failures are returned.
 */
export async function prepareFromPool(input: { cases: ScenarioCase[]; seed: number; ranker: OpinionRanker; maxAttempts?: number; excludeIds?: string[]; selection?: Partial<Omit<SelectionOptions, "seed">> }): Promise<{ ok: true; result: Extract<PrepareResult, { ok: true }>; failures: PrepareFailure[] } | { ok: false; failures: PrepareFailure[] }> {
  const rand = mulberry32(hashSeed("pool", input.seed));
  const order = input.cases.filter((c) => !input.excludeIds?.includes(c.id));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const failures: PrepareFailure[] = [];
  for (const [n, scenarioCase] of order.slice(0, input.maxAttempts ?? 3).entries()) {
    const r = await prepareRound({ scenarioCase, seed: hashSeed("attempt", input.seed, n), ranker: input.ranker, selection: input.selection });
    if (r.ok) return { ok: true, result: r, failures };
    failures.push(r);
  }
  return { ok: false, failures };
}
