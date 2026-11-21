import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerateOutcome } from "../../ai/src/index";
import { OPINION_SYSTEM, buildOpinionPrompt, createLlmOpinionGenerator, createMockChecker, createMockGenerator, generatePersonality, parseOpinionReply, prepareScenario, validateOpinions } from "../src/index";
import type { GenerationResult } from "../src/index";
import { READINGS, contentReport, raws, scenario } from "./opinion-fixtures";

const ok = (text: string): GenerateOutcome => ({ ok: true, result: { text, provider: "anthropic", model: "claude-sonnet-5-5", latencyMs: 5, inputTokens: 800, outputTokens: 300 } });
const insufficient = JSON.stringify({ insufficientDiversity: { reason: "The evidence supports only one coherent explanation." } });

test("the prompt demands different causal mechanisms, exploration first, honest scores and an explicit way out, without forcing disagreement", () => {
  for (const re of [/substantially different causal mechanisms/, /Do not return three variations of one underlying explanation/, /explore alternative explanations/i, /Different actors performing essentially the same act are ONE explanation/, /a guard stole it/, /moved it by accident during legitimate work/, /someone staged the disappearance/, /defending it against another would produce a substantive debate/, /Missing information is a gap, not a contradiction/, /do not manufacture unsupported ones/, /insufficientDiversity/, /do not raise a score to make the interpretations look balanced/, /ability to make a coherent, evidence-grounded argument/, /not the probability that it is true/, /must not narrow the range of causal explanations/, /you are not required to differ from anyone or to agree with anyone/])
    assert.match(OPINION_SYSTEM, re);
  assert.doesNotMatch(OPINION_SYSTEM, /archetype|persona type|you are (a|an) (sceptic|optimist)|must disagree|disagree with the other/i);
});

test("three different causal explanations are accepted by the local validator, and by the live adapter", async () => {
  assert.ok(validateOpinions(raws(["outsider", "loan", "staged"]), scenario).ok);
  const gen = createLlmOpinionGenerator(async () => ok(JSON.stringify({ opinions: raws(["outsider", "loan", "staged"]) })));
  assert.ok((await gen.generate({ side: "A", scenario, personality: generatePersonality(1, "A") })).ok);
});

test("copy-paste duplicates are stopped locally, but the local guard does not claim to judge meaning: reworded paraphrases pass it", () => {
  const good = raws(["outsider", "staged", "loan"]);
  assert.equal(validateOpinions([good[0], { ...good[1], title: good[0].title, explanation: good[0].explanation + " Also." }, good[2]], scenario).ok, false);
  assert.ok(validateOpinions(raws(["outsider", "outsiderParaphrase", "outsiderParaphrase2"]), scenario).ok); // semantic duplicates are the checker's job
  assert.ok(validateOpinions(raws(["employeeTook", "guardTook", "staffTook"]), scenario).ok); // same act, different actors: not decided by word overlap
});

test("three paraphrases of one explanation: the checker groups them, so only ONE distinct explanation counts for that agent", async () => {
  const gen = createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "outsiderParaphrase", "outsiderParaphrase2"]) : raws(["insider", "staged", "loan"])));
  const checker = createMockChecker(({ opinions }) => contentReport(opinions, {}, [["outsider", "outsiderParaphrase", "outsiderParaphrase2"]]));
  const r = await prepareScenario({ scenario, seed: 8, generator: gen, checker });
  assert.ok(r.ok);
  assert.deepEqual(r.meta.diversity, { A: 1, B: 3 });
  assert.equal(r.meta.selection.diagnostics.rejected.same_explanation, 0); // B has no copy of that idea
  assert.equal(r.meta.selection.diagnostics.pairsValid, 9); // all A copies are interchangeable stand-ins for one explanation
});

test("different actors doing essentially the same act are not automatically different explanations: grouped by the checker, they yield no debate", async () => {
  const gen = createMockGenerator((r) => (r.side === "A" ? raws(["employeeTook", "guardTook", "staffTook"]) : raws(["staffTook", "guardTook", "employeeTook"])));
  const same = createMockChecker(({ opinions }) => contentReport(opinions, {}, [["employeeTook", "guardTook", "staffTook"]]));
  const r = await prepareScenario({ scenario, seed: 9, generator: gen, checker: same });
  assert.ok(!r.ok && r.stage === "selection" && r.selection!.diagnostics.rejected.same_explanation === 9);
  assert.deepEqual(r.partial?.checkerReport?.equivalenceGroups.length, 1);
  // ...whereas a checker that finds them genuinely different keeps them: the decision is the checker's, not a word-overlap rule
  const differ = createMockChecker(({ opinions }) => contentReport(opinions, {}, []));
  const d = await prepareScenario({ scenario, seed: 9, generator: gen, checker: differ });
  assert.ok(!d.ok || d.meta.diversity.A === 3);
});

test("distinct but poorly supported theories are not automatically accepted: low checker scores remove them before pairing", async () => {
  const gen = createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "rival", "maintenance"], [90, 85, 80]) : raws(["insider", "rival", "staged"], [90, 85, 80])));
  const checker = createMockChecker(({ opinions }) => contentReport(opinions, { rival: { defensibility: 28 }, maintenance: { defensibility: 24, flag: "implausible" } }));
  const r = await prepareScenario({ scenario, seed: 10, generator: gen, checker });
  assert.ok(r.ok);
  assert.deepEqual(r.meta.diversity, { A: 3, B: 3 }); // distinct, yet...
  assert.ok(!["Rival collector's agent", "Sensor and wiring fault"].includes(r.meta.selection.a.title));
  assert.ok(!["Rival collector's agent", "Sensor and wiring fault"].includes(r.meta.selection.b.title));
  assert.equal(r.meta.selection.diagnostics.usableA, 1);
});

test("an explicit insufficient-diversity reply is a typed, non-retryable result, not a provider failure or invalid output", async () => {
  const p = parseOpinionReply(insufficient, "A", scenario);
  assert.ok(!p.ok && p.insufficientDiversity?.includes("only one coherent explanation"));
  const gen = createLlmOpinionGenerator(async () => ok(insufficient));
  const g = await gen.generate({ side: "A", scenario, personality: generatePersonality(1, "A") });
  assert.ok(!g.ok && g.error.code === "insufficient_diversity" && g.error.retryable === false && g.error.raw);
  // mixing both shapes is not an escape hatch
  assert.ok(!parseOpinionReply(JSON.stringify({ opinions: raws(["outsider", "staged", "loan"]).slice(0, 2), insufficientDiversity: { reason: "x" } }), "A", scenario).ok);
  const checker = createMockChecker(({ opinions }) => contentReport(opinions));
  const gm = createMockGenerator((r): GenerationResult | ReturnType<typeof raws> => (r.side === "A" ? { ok: false, error: { code: "insufficient_diversity", message: "only one reading", retryable: false } } : raws(["insider", "staged", "loan"])));
  const r = await prepareScenario({ scenario, seed: 11, generator: gm, checker });
  assert.ok(!r.ok && r.stage === "generation" && r.error?.code === "insufficient_diversity" && /Agent A found fewer than three distinct/.test(r.message));
  assert.equal(r.llmCalls, 2);
  assert.equal(checker.requests.length, 0); // never forced into a checker call or a debate
});

test("the two agents remain independent: a request holds only its own personality, and B's request is identical whether or not A succeeds", async () => {
  const seen: Record<string, string[]> = { ok: [], insufficient: [] };
  for (const mode of ["ok", "insufficient"] as const) {
    const gen = createLlmOpinionGenerator(async (_c, req) => {
      seen[mode].push(req.prompt);
      return ok(req.prompt.includes("YOUR REASONING TENDENCIES") && mode === "insufficient" && seen[mode].length === 1 ? insufficient : JSON.stringify({ opinions: raws(["insider", "staged", "loan"]) }));
    });
    const [pa, pb] = [generatePersonality(5, "A"), generatePersonality(5, "B")];
    await Promise.all([gen.generate({ side: "A", scenario, personality: pa }), gen.generate({ side: "B", scenario, personality: pb })]);
  }
  assert.equal(seen.ok[1], seen.insufficient[1]); // B's prompt does not depend on what A returned
  for (const p of [...seen.ok, ...seen.insufficient]) for (const k of Object.values(READINGS)) assert.ok(!p.includes(k.explanation));
  assert.equal(buildOpinionPrompt({ side: "A", scenario, personality: generatePersonality(5, "A") }).includes("Agent B"), false);
});
