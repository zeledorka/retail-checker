import { test } from "node:test";
import assert from "node:assert/strict";
import { anonymise, selectFinalPair } from "../src/index";
import type { GeneratedOpinion } from "../src/index";
import { READINGS, contentReport, opinionsFor } from "./opinion-fixtures";
import type { Key, Spec } from "./opinion-fixtures";

type Keys = [Key, Key, Key];
function run(a: Keys, b: Keys, spec: Spec = {}, seed = 1, orderSeed = seed, opts: Parameters<typeof selectFinalPair>[1] extends infer O ? Partial<O> : never = {}, scoresA?: [number, number, number], scoresB?: [number, number, number]) {
  const A = opinionsFor("A", a, scoresA);
  const B = opinionsFor("B", b, scoresB);
  const { checkerOpinions, order } = anonymise([...A, ...B], orderSeed);
  return selectFinalPair({ opinionsA: A, opinionsB: B, checkerOrder: order, report: contentReport(checkerOpinions, spec) }, { seed, ...opts });
}
const titles = (r: ReturnType<typeof run>) => (r.ok ? [r.a.title, r.b.title] : []);

test("two different causal explanations are paired and returned with the hidden mapping restored", () => {
  const r = run(["outsider", "staged", "loan"], ["insider", "maintenance", "staged"]);
  assert.ok(r.ok);
  assert.ok(r.a.side === "A" && r.b.side === "B" && r.a.id.startsWith("A") && r.b.id.startsWith("B"));
  assert.notEqual(r.a.explanation, r.b.explanation);
  assert.equal(r.diagnostics.pairsConsidered, 9);
});

test("semantic duplicates in different wording are rejected as a pairing", () => {
  const r = run(["outsider", "staged", "loan"], ["outsiderParaphrase", "outsiderParaphrase", "outsiderParaphrase"].slice(0, 1).concat(["insider", "maintenance"]) as Keys);
  assert.ok(r.ok);
  assert.ok(r.diagnostics.rejected.same_explanation >= 1);
  assert.ok(!(r.a.title === "Outsider on impulse" && r.b.title === "Hidden visitor"));
  // only paraphrases of one explanation on the table: no pair at all
  const only = run(["outsider", "outsider", "outsider"], ["outsiderParaphrase", "outsiderParaphrase", "outsiderParaphrase"]);
  assert.ok(!only.ok && only.reason === "no_credible_opposing_pair" && only.diagnostics.rejected.same_explanation === 9);
});

test("a disagreement that is only cosmetic is rejected even when the explanations differ in wording", () => {
  const A = opinionsFor("A", ["outsider", "staged", "loan"]);
  const B = opinionsFor("B", ["insider", "maintenance", "staged"]);
  const { checkerOpinions, order } = anonymise([...A, ...B], 2);
  const base = contentReport(checkerOpinions);
  const report = { ...base, pairs: base.pairs.map((p) => ({ ...p, meaningful: false, difference: 18 })) };
  const r = selectFinalPair({ opinionsA: A, opinionsB: B, checkerOrder: order, report }, { seed: 1 });
  assert.ok(!r.ok && r.diagnostics.rejected.cosmetic_difference > 0);
  const lowDifference = { ...base, pairs: base.pairs.map((p) => ({ ...p, meaningful: true, difference: 25 })) };
  assert.ok(!selectFinalPair({ opinionsA: A, opinionsB: B, checkerOrder: order, report: lowDifference }, { seed: 1 }).ok);
});

test("weak, unsupported and contradicted opinions are never used, whatever the agent thought of them", () => {
  const spec: Spec = { outsider: { defensibility: 25 }, staged: { flag: "contradicted", defensibility: 90 }, loan: { flag: "contradicted", defensibility: 85 } };
  const r = run(["outsider", "staged", "loan"], ["insider", "maintenance", "staged"], spec, 1, 1, {}, [95, 90, 85]);
  assert.ok(!r.ok); // every A opinion is unusable (self-scores of 95 cannot rescue them)
  assert.equal(r.diagnostics.usableA, 0);
  const some = run(["outsider", "staged", "loan"], ["insider", "maintenance", "staged"], { outsider: { defensibility: 25 }, staged: { flag: "contradicted" } });
  assert.ok(some.ok && some.a.title === "Unlogged loan move");
  const penal = run(["outsider", "staged", "loan"], ["insider", "maintenance", "insider"], { outsider: { flag: "unsupported", defensibility: 70 } });
  assert.ok(penal.ok && penal.a.title !== "Outsider on impulse");
});

test("no credible opposing pair: an explicit failure with diagnostics, never a forced debate", () => {
  const spec: Spec = Object.fromEntries((Object.keys(READINGS) as Key[]).map((k) => [k, { defensibility: 25 }]));
  const r = run(["outsider", "staged", "loan"], ["insider", "maintenance", "staged"], spec);
  assert.ok(!r.ok && r.reason === "no_credible_opposing_pair");
  assert.match(r.message, /no meaningful, defensible, balanced pair/);
  assert.equal(r.diagnostics.pairsValid, 0);
  const lopsided = run(["outsider", "staged", "loan"], ["insider", "maintenance", "insider"], { outsider: { defensibility: 92 }, staged: { defensibility: 92 }, loan: { defensibility: 92 }, insider: { defensibility: 46 }, maintenance: { defensibility: 46 } });
  assert.ok(!lopsided.ok && lopsided.diagnostics.rejected.unbalanced > 0); // one side overwhelmingly weak is never forced
});

test("both agents producing the same three opinions yields no same-explanation pairing", () => {
  const r = run(["outsider", "staged", "loan"], ["outsider", "staged", "loan"]);
  assert.ok(r.ok);
  assert.notEqual(r.a.title, r.b.title);
  assert.equal(r.diagnostics.rejected.same_explanation, 3);
  assert.equal(r.diagnostics.pairsValid, 6);
});

test("the agent's own preference rank adds only a modest bonus: a clearly better-defended pair beats a preferred weaker one", () => {
  // A ranks "staged" first, but the checker finds "loan" far better defended; with the 12-point maximum bonus the stronger pair still wins.
  const r = run(["staged", "outsider", "loan"], ["insider", "insider", "insider"], { staged: { defensibility: 48 }, outsider: { defensibility: 50 }, loan: { defensibility: 74 }, insider: { defensibility: 70 } }, 1, 1, { tieMargin: 0 });
  assert.ok(r.ok);
  assert.equal(r.a.title, "Unlogged loan move");
  // all else equal the higher-ranked opinion wins
  const tie = run(["staged", "outsider", "loan"], ["insider", "maintenance", "insider"], {}, 1, 1, { tieMargin: 0 });
  assert.ok(tie.ok && tie.a.rank === 1 && tie.b.rank === 1);
});

test("selection is deterministic for identical validated assessments and seed, and the seed only breaks near-ties", () => {
  const args = [["outsider", "staged", "loan"], ["insider", "maintenance", "staged"]] as [Keys, Keys];
  for (let s = 0; s < 10; s++) assert.deepEqual(run(...args, {}, s), run(...args, {}, s));
  const picks = new Set<string>();
  for (let s = 0; s < 60; s++) picks.add(titles(run(...args, {}, s, s, { tieMargin: 100 })).join("|"));
  assert.ok(picks.size > 3, "the seed should vary the choice among tied pairs");
  const strict = new Set<string>();
  for (let s = 0; s < 30; s++) strict.add(titles(run(...args, {}, s, s, { tieMargin: 0 }, [90, 70, 50], [90, 70, 50])).join("|"));
  assert.equal(strict.size, 1); // no tie, so the best pair wins for every seed
});

test("swapping the A/B labels mirrors the result; shuffling the checker's order does not change it. Differences are counted, not assumed away.", () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i + 100);
  const sets: [Keys, Keys][] = [
    [["outsider", "staged", "loan"], ["insider", "maintenance", "staged"]],
    [["staged", "loan", "insider"], ["outsider", "maintenance", "loan"]],
    [["maintenance", "insider", "outsider"], ["staged", "loan", "outsiderParaphrase"]],
  ];
  let swapDiff = 0;
  let shuffleDiff = 0;
  let total = 0;
  for (const [a, b] of sets)
    for (const s of seeds) {
      const base = run(a, b, {}, s, s);
      const swapped = run(b, a, {}, s, s);
      const reshuffled = run(a, b, {}, s, s + 9999);
      total++;
      const key = (r: ReturnType<typeof run>) => (r.ok ? `${r.a.title}|${r.b.title}` : "none");
      const mirror = (r: ReturnType<typeof run>) => (r.ok ? `${r.b.title}|${r.a.title}` : "none");
      if (key(base) !== mirror(swapped)) swapDiff++;
      if (key(base) !== key(reshuffled)) shuffleDiff++;
    }
  console.log(`[recorded] label swap changed the chosen pair in ${swapDiff}/${total} runs; checker order shuffle changed it in ${shuffleDiff}/${total} runs (checker verdicts keyed on content, i.e. a perfectly consistent checker)`);
  assert.equal(shuffleDiff, 0);
  assert.equal(swapDiff, 0);
});

test("neither the agent label nor the position in a list is an input: shuffling each agent's own list order leaves the choice unchanged", () => {
  const A = opinionsFor("A", ["outsider", "staged", "loan"]);
  const B = opinionsFor("B", ["insider", "maintenance", "staged"]);
  const choose = (a: GeneratedOpinion[], b: GeneratedOpinion[]) => {
    const { checkerOpinions, order } = anonymise([...a, ...b], 5);
    const r = selectFinalPair({ opinionsA: a, opinionsB: b, checkerOrder: order, report: contentReport(checkerOpinions) }, { seed: 5 });
    return r.ok ? `${r.a.title}|${r.b.title}` : "none";
  };
  const base = choose(A, B);
  assert.equal(choose([...A].reverse(), [...B].reverse()), base);
  assert.equal(choose([A[1], A[2], A[0]], [B[2], B[0], B[1]]), base);
});
