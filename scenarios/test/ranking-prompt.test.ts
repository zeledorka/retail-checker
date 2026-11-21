import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PREPARED_CASES, RANKER_SYSTEM, describePersonality, generatePersonality } from "../src/index";
import type { Personality } from "../src/index";
import { EVAL_PLAN, EVAL_REQUEST_CAP, copiesListingOrder, firstChoicePosition, kendallTau, personalityDistance, shuffled } from "../src/evaluation";

const base = generatePersonality(1, "A");
const withTraits = (over: Partial<Personality>): Personality => ({ ...base, ...over });

test("defensibility is defined as how reasonably the interpretation can be defended, not as a probability, with the five anchors", () => {
  assert.match(RANKER_SYSTEM, /how reasonably you could defend the interpretation in a debate using the available evidence/);
  assert.match(RANKER_SYSTEM, /not a probability that the interpretation is true/);
  for (const anchor of [/0-20 cannot reasonably be defended from the evidence/, /21-39 very weak, largely speculative/, /40-59 arguable but with significant evidentiary gaps/, /60-79 credible, with meaningful supporting evidence/, /80-100 strongly defensible, with substantial evidence/])
    assert.match(RANKER_SYSTEM, anchor);
});

test("several interpretations may legitimately score above 60, scores are not to be inflated, and a single credible reading is to be reported", () => {
  assert.match(RANKER_SYSTEM, /several interpretations above 60/);
  assert.match(RANKER_SYSTEM, /Do not inflate or deflate scores/);
  assert.match(RANKER_SYSTEM, /if the evidence supports only one credible interpretation, give the others low scores and say so/);
  assert.doesNotMatch(RANKER_SYSTEM, /raise (your )?scores|at least 60|above 60 for/i); // no instruction to push scores up
});

test("personality is explained as a way of weighing evidence, never as an instruction to disagree or to invent facts", () => {
  assert.match(RANKER_SYSTEM, /HOW YOU WEIGH the evidence/);
  assert.match(RANKER_SYSTEM, /do not oblige you to pick a different reading from anyone else/);
  assert.match(RANKER_SYSTEM, /never allow invented facts and never override the evidence/);
  assert.doesNotMatch(RANKER_SYSTEM, /must (choose|pick|select) a different|disagree with|opposite reading|contrarian answer/i);
  // each weighing rule named in the brief is present
  for (const rule of [/penalises readings that need unsupported claims/, /accept indirect but coherent evidence/, /favours readings that need fewer assumptions/, /favour a bolder reading when it can still be defended/]) assert.match(RANKER_SYSTEM, rule);
});

test("each trait changes the weighing text, in both directions, and the descriptions stay free of archetype names", () => {
  const sceptical = describePersonality(withTraits({ evidenceScepticism: 0.9 }));
  const lax = describePersonality(withTraits({ evidenceScepticism: 0.1 }));
  assert.match(sceptical, /mark down any reading that depends on a claim the evidence does not support/);
  assert.match(lax, /count a plausible reading as defensible even if some links are assumed/);
  assert.match(describePersonality(withTraits({ inferenceWillingness: 0.9 })), /real weight to indirect evidence that fits together coherently/);
  assert.match(describePersonality(withTraits({ inferenceWillingness: 0.1 })), /little weight to evidence that only works through an inference/);
  assert.match(describePersonality(withTraits({ simplicityPreference: 0.9 })), /mark down readings that need many separate assumptions/);
  assert.match(describePersonality(withTraits({ simplicityPreference: 0.1 })), /not marked down for needing several assumptions/);
  assert.match(describePersonality(withTraits({ riskTolerance: 0.9 })), /rank a bolder reading highly if it can still be defended/);
  assert.match(describePersonality(withTraits({ riskTolerance: 0.1 })), /hardest to attack/);
  for (const d of [sceptical, lax]) assert.doesNotMatch(d, /archetype|persona:|you are the (sceptic|dreamer|detective)/i);
  // the whole description still never licenses invented facts and never forces a different answer
  assert.match(sceptical, /never allow you to invent facts, witnesses or findings/);
  assert.match(sceptical, /not required to reach a different reading from anyone else/);
});

test("descriptions stay highly varied across seeds after the added weighing text", () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 200; seed++) seen.add(describePersonality(generatePersonality(seed, "A")));
  assert.ok(seen.size >= 150, `${seen.size} distinct descriptions in 200 seeds`);
});

test("the evaluation plan is small and fixed: 6 runs, 12 paid requests, the required scenarios and seeds", () => {
  assert.equal(EVAL_PLAN.length, 6);
  assert.equal(EVAL_REQUEST_CAP, 12);
  const ids = EVAL_PLAN.map((p) => p.caseId);
  assert.equal(ids.filter((id) => id === "empty-display-case").length, 2); // two seeds for The Empty Display Case
  assert.equal(ids.filter((id) => id === "silent-call").length, 1); // one for The Silent Call
  const others = ids.filter((id) => id !== "empty-display-case" && id !== "silent-call");
  assert.equal(others.length, 3);
  assert.equal(new Set(others).size, 3); // across three other prepared scenarios
  assert.equal(new Set(EVAL_PLAN.map((p) => p.seed)).size, 6);
  for (const id of ids) assert.ok(PREPARED_CASES.some((c) => c.id === id), id);
});

test("the live evaluation script makes no request unless it is given --approved", () => {
  const out = execFileSync("npx", ["tsx", "scripts/evaluate-live.ts"], { cwd: new URL("..", import.meta.url), env: { ...process.env, ANTHROPIC_API_KEY: "" }, encoding: "utf8" });
  assert.match(out, /Plan: 6 runs, 12 paid requests/);
  assert.match(out, /NOT RUN: no --approved flag, so no request was made/);
});

test("evaluation helpers: seeded listing shuffle, rank agreement, personality distance, position and order-copy checks", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(shuffled(items, 5), shuffled(items, 5));
  assert.deepEqual([...shuffled(items, 5)].sort(), items);
  assert.ok(new Set(Array.from({ length: 30 }, (_, s) => shuffled(items, s).join(""))).size >= 8); // the order really varies between runs
  assert.equal(kendallTau(["a", "b", "c"], ["a", "b", "c"]), 1);
  assert.equal(kendallTau(["a", "b", "c"], ["c", "b", "a"]), -1);
  assert.equal(kendallTau(["a"], ["b"]), undefined);
  assert.equal(kendallTau(["a", "b"], ["c", "a"]), undefined); // fewer than two shared ids
  const a = generatePersonality(1, "A");
  assert.equal(personalityDistance(a, a), 0);
  let max = 0;
  for (let s = 1; s <= 200; s++) max = Math.max(max, personalityDistance(generatePersonality(s, "A"), generatePersonality(s, "B")));
  assert.ok(max > 0.3 && max <= 1);
  const listing = ["x", "y", "z"];
  assert.equal(firstChoicePosition(listing, [{ id: "z" }, { id: "x" }]), 2);
  assert.ok(copiesListingOrder(listing, [{ id: "x" }, { id: "y" }, { id: "z" }]));
  assert.ok(!copiesListingOrder(listing, [{ id: "y" }, { id: "x" }]));
});
