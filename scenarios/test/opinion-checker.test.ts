import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerateOutcome } from "../../ai/src/index";
import { CHECKER_SYSTEM, anonymise, buildCheckerPrompt, createLlmChecker, describePersonality, generatePersonality, parseCheckerReply, validateCheckerReport } from "../src/index";
import { contentReport, opinionsFor, scenario } from "./opinion-fixtures";

const six = () => [...opinionsFor("A", ["outsider", "staged", "loan"], [91, 77, 63]), ...opinionsFor("B", ["insider", "maintenance", "staged"], [88, 55, 44])];
const ok = (text: string): GenerateOutcome => ({ ok: true, result: { text, provider: "anthropic", model: "claude-sonnet-5-5", latencyMs: 9, inputTokens: 1500, outputTokens: 900 } });

test("the checker request is blind: content only, anonymous ids, no side, personality, rank, self-score or original id", () => {
  const { checkerOpinions, order } = anonymise(six(), 42);
  assert.equal(checkerOpinions.length, 6);
  for (const o of checkerOpinions) assert.deepEqual(Object.keys(o).sort(), ["explanation", "id", "supportingEvidenceIds", "title", "weaknesses"]);
  assert.deepEqual(checkerOpinions.map((o) => o.id), ["o1", "o2", "o3", "o4", "o5", "o6"]);
  const prompt = buildCheckerPrompt(scenario, checkerOpinions);
  const all = prompt + CHECKER_SYSTEM;
  for (const forbidden of [/\bA[123]\b/, /\bB[123]\b/, /Agent [AB]/, /selfDefensibility|rank:|personality|evidence standard|willingness to infer/i, /\bbet|audience|odds|balance|debate history/i]) assert.doesNotMatch(prompt, forbidden);
  assert.doesNotMatch(CHECKER_SYSTEM, /personality|\bbet|audience|agent a|agent b/i);
  for (const p of [generatePersonality(1, "A"), generatePersonality(1, "B")]) assert.ok(!all.includes(describePersonality(p)));
  for (const s of ["80", "91", "88"]) assert.doesNotMatch(prompt.replace(/e\d/g, ""), new RegExp(`defensib\\w*:? ?${s}`));
  assert.equal(order.length, 6);
  assert.equal(new Set(order.map((x) => x.anonId)).size, 6);
});

test("the anonymous order is a seeded shuffle that is not the generation order and restores the true mapping", () => {
  const ops = six();
  const a = anonymise(ops, 7);
  assert.deepEqual(anonymise(ops, 7), a); // deterministic
  const orders = new Set<string>();
  for (let s = 0; s < 30; s++) orders.add(anonymise(ops, s).order.map((x) => x.opinionId).join(""));
  assert.ok(orders.size > 10, `only ${orders.size} distinct orders`);
  for (const x of a.order) {
    const original = ops.find((o) => o.id === x.opinionId)!;
    assert.equal(a.checkerOpinions.find((c) => c.id === x.anonId)!.explanation, original.explanation);
  }
  // the first-listed opinion is not systematically from one agent
  const firstSides = new Set<string>();
  for (let s = 0; s < 40; s++) firstSides.add(anonymise(ops, s).order[0].opinionId[0]);
  assert.equal(firstSides.size, 2);
});

test("checker reports are validated: unknown ids, missing assessments, missing or duplicate pairs, bad scores and groups are rejected", () => {
  const { checkerOpinions } = anonymise(six(), 1);
  const ids = checkerOpinions.map((o) => o.id);
  const good = contentReport(checkerOpinions);
  assert.ok(validateCheckerReport(good, ids).ok);
  const bad: [string, unknown][] = [
    ["missing assessment", { ...good, assessments: good.assessments.slice(1) }],
    ["unknown id", { ...good, assessments: [{ ...good.assessments[0], id: "o9" }, ...good.assessments.slice(1)] }],
    ["score 140", { ...good, assessments: [{ ...good.assessments[0], defensibility: 140 }, ...good.assessments.slice(1)] }],
    ["bad flag", { ...good, assessments: [{ ...good.assessments[0], flag: "maybe" }, ...good.assessments.slice(1)] }],
    ["missing pair", { ...good, pairs: good.pairs.slice(1) }],
    ["duplicate pair", { ...good, pairs: [good.pairs[0], good.pairs[0], ...good.pairs.slice(2)] }],
    ["group of one", { ...good, equivalenceGroups: [["o1"]] }],
    ["id in two groups", { ...good, equivalenceGroups: [["o1", "o2"], ["o2", "o3"]] }],
    ["meaningful not boolean", { ...good, pairs: [{ ...good.pairs[0], meaningful: "yes" }, ...good.pairs.slice(1)] }],
  ];
  for (const [name, raw] of bad) assert.equal(validateCheckerReport(raw, ids).ok, false, name);
});

test("the live checker adapter makes one request, validates the reply, and reports invalid output as a typed retryable error", async () => {
  const { checkerOpinions } = anonymise(six(), 3);
  const report = contentReport(checkerOpinions);
  let calls = 0;
  const llm = createLlmChecker(async () => (calls++, ok("```json\n" + JSON.stringify(report) + "\n```")));
  const r = await llm.check({ scenario, opinions: checkerOpinions });
  assert.ok(r.ok && calls === 1 && r.telemetry?.outputTokens === 900);
  assert.ok(!parseCheckerReply("no json here", checkerOpinions.map((o) => o.id)).ok);
  const broken = createLlmChecker(async () => ok(JSON.stringify({ ...report, pairs: [] })));
  const b = await broken.check({ scenario, opinions: checkerOpinions });
  assert.ok(!b.ok && b.error.code === "invalid_output" && b.error.retryable);
});
