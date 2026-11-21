import { test } from "node:test";
import assert from "node:assert/strict";
import { describePersonality, generatePersonality, hashSeed, mulberry32 } from "../src/index";
import type { Personality } from "../src/index";

const TRAITS: (keyof Personality)[] = ["evidenceScepticism", "inferenceWillingness", "riskTolerance", "simplicityPreference", "directness", "rhetoricalFlourish", "rebuttalAggression"];

test("the same seed always gives the same personalities (reproducible runs)", () => {
  assert.deepEqual(generatePersonality(12345, "A"), generatePersonality(12345, "A"));
  assert.deepEqual(generatePersonality(12345, "B"), generatePersonality(12345, "B"));
  assert.equal(describePersonality(generatePersonality(7, "A")), describePersonality(generatePersonality(7, "A")));
});

test("all traits are bounded to [0.05, 0.95]", () => {
  for (let seed = 0; seed < 300; seed++)
    for (const side of ["A", "B"] as const) {
      const p = generatePersonality(seed * 7919, side);
      for (const t of TRAITS) assert.ok((p[t] as number) >= 0.05 && (p[t] as number) <= 0.95, `${seed} ${side} ${t}`);
    }
});

test("A and B are generated independently and vary across seeds; there is no small archetype list", () => {
  let identicalAB = 0;
  const descriptions = new Set<string>();
  const evidenceScepticismA = new Set<number>();
  for (let seed = 1; seed <= 200; seed++) {
    const a = generatePersonality(seed, "A");
    const b = generatePersonality(seed, "B");
    if (TRAITS.every((t) => a[t] === b[t])) identicalAB++;
    descriptions.add(describePersonality(a));
    evidenceScepticismA.add(a.evidenceScepticism);
  }
  assert.equal(identicalAB, 0);
  assert.ok(descriptions.size >= 150, `only ${descriptions.size} distinct descriptions in 200 seeds`);
  assert.ok(evidenceScepticismA.size > 60);
  // within one seed the sides are not copies of each other, and one side does not predict the other
  const a = generatePersonality(99, "A");
  const b = generatePersonality(99, "B");
  assert.notDeepEqual({ ...a, side: "x" }, { ...b, side: "x" });
});

test("the description shapes preference and style only: it forbids invented facts and overriding evidence", () => {
  const d = describePersonality(generatePersonality(3, "A"));
  assert.match(d, /never allow you to invent facts, witnesses or findings/);
  assert.match(d, /never override the evidence/);
  assert.doesNotMatch(d, /Agent [AB]/); // no side label, no hint of the opponent
});

test("the seeded generator is stable and well spread", () => {
  assert.equal(hashSeed("a", 1), hashSeed("a", 1));
  assert.notEqual(hashSeed("a", 1), hashSeed("a", 2));
  const r = mulberry32(42);
  const xs = Array.from({ length: 1000 }, () => r());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(xs.reduce((s, x) => s + x, 0) / 1000 - 0.5) < 0.05);
  assert.deepEqual(Array.from({ length: 3 }, mulberry32(42)), Array.from({ length: 3 }, mulberry32(42)));
});
