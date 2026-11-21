import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOpinions, validateRanking, DEFAULT_MIN_STRENGTH } from "../src/index";
import type { Interpretation, RawRankingItem } from "../src/index";

const cands: Interpretation[] = ["i1", "i2", "i3", "i4"].map((id) => ({ id, label: `Label ${id}`, description: `Description of ${id}` }));
const item = (id: string, rank: number, defensibility: number): RawRankingItem => ({ id, rank, defensibility, explanation: `because of the evidence for ${id}` });
const pick = (a: RawRankingItem[], b: RawRankingItem[], over: object = {}) => selectOpinions({ candidates: cands, rankingA: a, rankingB: b }, { seed: 1, tieMargin: 0, ...over });

test("different top-ranked opinions are chosen as they are", () => {
  const r = pick([item("i1", 1, 90), item("i2", 2, 70)], [item("i3", 1, 85), item("i4", 2, 65)]);
  assert.ok(r.ok);
  assert.deepEqual([r.a.id, r.b.id], ["i1", "i3"]);
  assert.equal(r.chosen.score, 90 + 85 + 10 + 10); // defensibility + the first-choice bonus on each side
  assert.equal(r.diagnostics.pairsConsidered, 4);
});

test("both agents preferring the same top opinion: the best credible DIFFERENT pair is used, with the rank bonus preferring first choices", () => {
  const r = pick([item("i1", 1, 90), item("i2", 2, 75), item("i3", 3, 62)], [item("i1", 1, 88), item("i2", 2, 80), item("i4", 3, 61)]);
  assert.ok(r.ok);
  // candidates: (i1,i2)=90+80+10+3, (i2,i1)=75+88+3+10, (i1,i4)=90+61+10, (i2,i4), (i3,i1)=62+88+10, ...
  assert.deepEqual([r.a.id, r.b.id], ["i1", "i2"]);
  assert.equal(r.diagnostics.pairsSameInterpretation, 2); // (i1,i1) and (i2,i2) removed
  assert.notEqual(r.a.id, r.b.id);
});

test("only one credible interpretation for both: explicit failure, never a forced weak third choice", () => {
  const r = pick([item("i1", 1, 92), item("i2", 2, 44), item("i3", 3, 40)], [item("i1", 1, 90), item("i4", 2, 43), item("i3", 3, 30)]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.reason, "no_credible_opposing_pair");
  assert.equal(r.diagnostics?.pairsValid, 0);
  assert.ok(r.diagnostics!.pairsSameInterpretation >= 1 && r.diagnostics!.pairsBelowStrength >= 1);
});

test("the minimum strength is configurable and applied to each opinion (default 45 after the first live run)", () => {
  assert.equal(DEFAULT_MIN_STRENGTH, 45);
  const a = [item("i1", 1, 90), item("i2", 2, 44)];
  const b = [item("i1", 1, 90), item("i3", 2, 45)];
  const strict = pick(a, b);
  assert.ok(strict.ok);
  assert.deepEqual([strict.a.id, strict.b.id], ["i1", "i3"]); // 44 is out, exactly 45 is in
  assert.equal(pick(a, b, { minStrength: 46 }).ok, false);
  const loose = pick(a, b, { minStrength: 40 });
  assert.ok(loose.ok);
  assert.equal(loose.diagnostics.minStrength, 40);
  const high = pick([item("i1", 1, 70), item("i2", 2, 62)], [item("i3", 1, 70)], { minStrength: 65 });
  assert.ok(high.ok);
  assert.deepEqual([high.a.id, high.b.id], ["i1", "i3"]);
});

test("duplicate, invented and malformed rankings are rejected with the side and the reasons", () => {
  const bad: [string, unknown][] = [
    ["duplicate id", [item("i1", 1, 80), item("i1", 2, 70)]],
    ["invented id", [item("zzz", 1, 80)]],
    ["rank gap", [item("i1", 1, 80), item("i2", 3, 70)]],
    ["rank repeat", [item("i1", 1, 80), item("i2", 1, 70)]],
    ["four items", [item("i1", 1, 90), item("i2", 2, 80), item("i3", 3, 70), item("i4", 4, 65)]],
    ["empty", []],
    ["not a list", { ranking: [] }],
    ["defensibility above 100", [item("i1", 1, 101)]],
    ["negative", [item("i1", 1, -1)]],
    ["string score", [{ id: "i1", rank: 1, defensibility: "80", explanation: "x" }]],
    ["no explanation", [{ id: "i1", rank: 1, defensibility: 80, explanation: " " }]],
    ["fractional rank", [{ id: "i1", rank: 1.5, defensibility: 80, explanation: "x" }]],
  ];
  for (const [name, ranking] of bad) {
    const r = selectOpinions({ candidates: cands, rankingA: ranking, rankingB: [item("i2", 1, 80)] }, { seed: 1 });
    assert.ok(!r.ok && r.reason === "invalid_ranking" && r.side === "A" && r.errors.length > 0, name);
    const r2 = selectOpinions({ candidates: cands, rankingA: [item("i2", 1, 80)], rankingB: ranking }, { seed: 1 });
    assert.ok(!r2.ok && r2.reason === "invalid_ranking" && r2.side === "B", name);
  }
  assert.ok(validateRanking([item("i2", 2, 70), item("i1", 1, 80)], new Set(["i1", "i2"])).ok); // order in the reply does not matter
});

test("selection is deterministic: the same inputs and seed give the same result, and it never calls a model", () => {
  const a = [item("i1", 1, 80), item("i2", 2, 80)];
  const b = [item("i3", 1, 80), item("i4", 2, 80)];
  const first = pick(a, b, { seed: 77, tieMargin: 20 });
  for (let n = 0; n < 5; n++) assert.deepEqual(pick(a, b, { seed: 77, tieMargin: 20 }), first);
  assert.equal(typeof selectOpinions, "function"); // synchronous and pure: it returns a value, not a promise
  assert.ok(!(first instanceof Promise));
});

test("seeded tie-breaking gives variety across seeds while ties stay inside the margin", () => {
  const a = [item("i1", 1, 80), item("i2", 2, 77), item("i3", 3, 75)];
  const b = [item("i4", 1, 80), item("i2", 2, 77), item("i1", 3, 75)];
  const seen = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const r = pick(a, b, { seed, tieMargin: 10 });
    assert.ok(r.ok);
    assert.ok(r.chosen.score >= r.diagnostics.bestScore! - 10);
    seen.add(`${r.a.id}/${r.b.id}`);
  }
  assert.ok(seen.size >= 3, `only ${[...seen].join(", ")}`);
  // with no margin the strictly best pair always wins
  const strict = new Set(Array.from({ length: 30 }, (_, seed) => { const r = pick(a, b, { seed, tieMargin: 0 }); return r.ok ? `${r.a.id}/${r.b.id}` : "x"; }));
  assert.equal(strict.size, 1);
});

test("a first-ranked choice gets a modest bonus: it beats a slightly higher second choice but not a much stronger one", () => {
  const modest = pick([item("i1", 1, 78), item("i2", 2, 82)], [item("i3", 1, 80)]);
  assert.ok(modest.ok && modest.a.id === "i1"); // 78+10 > 82+3
  const strong = pick([item("i1", 1, 70), item("i2", 2, 95)], [item("i3", 1, 80)]);
  assert.ok(strong.ok && strong.a.id === "i2"); // 70+10 < 95+3
});

test("candidate problems are reported, not thrown", () => {
  const r = selectOpinions({ candidates: [cands[0], cands[0]], rankingA: [], rankingB: [] }, { seed: 1 });
  assert.ok(!r.ok && r.reason === "invalid_ranking");
});

test("replay of the first live run (Sonnet 5.5): the recorded self-assessments fail at 60 and give sensible results at the default", () => {
  const id = (s: string) => s;
  const cases: { c: string[]; a: [string, number][]; b: [string, number][] }[] = [
    { c: ["opportunistic-theft", "staged-theft", "handling-error", "personal-motive-insider"], a: [["handling-error", 55], ["personal-motive-insider", 40], ["opportunistic-theft", 30]], b: [["handling-error", 55], ["personal-motive-insider", 48], ["staged-theft", 35]] },
    { c: ["opportunistic-theft", "staged-theft", "handling-error", "personal-motive-insider"], a: [["handling-error", 55], ["opportunistic-theft", 35], ["staged-theft", 22]], b: [["handling-error", 50], ["opportunistic-theft", 32], ["staged-theft", 18]] },
    { c: ["prank-call", "equipment-fault", "targeted-intimidation", "wrong-number-loop"], a: [["equipment-fault", 62], ["wrong-number-loop", 52], ["prank-call", 35]], b: [["wrong-number-loop", 62], ["equipment-fault", 58], ["targeted-intimidation", 35]] },
  ];
  const run = (k: number, minStrength?: number) => {
    const x = cases[k];
    const mk = (r: [string, number][]) => r.map(([i, d], n) => item(id(i), n + 1, d));
    return selectOpinions({ candidates: x.c.map((i) => ({ id: i, label: i, description: i })), rankingA: mk(x.a), rankingB: mk(x.b) }, { seed: 1, tieMargin: 0, ...(minStrength !== undefined ? { minStrength } : {}) });
  };
  assert.deepEqual([0, 1, 2].map((k) => run(k, 60).ok), [false, false, true]); // the old default: two of three runs had no usable pair
  const r0 = run(0);
  assert.ok(r0.ok);
  assert.deepEqual([r0.a.id, r0.b.id], ["handling-error", "personal-motive-insider"]); // distinct, both rated above the default
  assert.ok(!run(1).ok); // both agents only credibly back the same reading: still an honest failure, not a forced pair
  const r2 = run(2);
  assert.ok(r2.ok);
  assert.deepEqual([r2.a.id, r2.b.id], ["equipment-fault", "wrong-number-loop"]);
});
