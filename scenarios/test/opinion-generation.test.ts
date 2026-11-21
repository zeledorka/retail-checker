import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { OPINION_SYSTEM, PREPARED_CASES, buildOpinionPrompt, createLlmOpinionGenerator, createMockGenerator, describePersonality, generatePersonality, parseOpinionReply, validateOpinions } from "../src/index";
import { READINGS, raws, scenario } from "./opinion-fixtures";

const reply = (keys: Parameters<typeof raws>[0]) => JSON.stringify({ opinions: raws(keys).map((o) => ({ ...o })) });
const ok = (text: string): GenerateOutcome => ({ ok: true, result: { text, provider: "anthropic", model: "claude-sonnet-5-5", latencyMs: 12, inputTokens: 900, outputTokens: 400 } });

test("each agent returns exactly three opinions with system-assigned ids, ranks 1-3 and valid evidence ids", async () => {
  const gen = createLlmOpinionGenerator(async () => ok(reply(["outsider", "staged", "loan"])));
  const r = await gen.generate({ side: "A", scenario, personality: generatePersonality(1, "A") });
  assert.ok(r.ok);
  assert.equal(r.opinions.length, 3);
  assert.deepEqual(r.opinions.map((o) => o.id), ["A1", "A2", "A3"]);
  assert.deepEqual(r.opinions.map((o) => o.rank).sort(), [1, 2, 3]);
  const ids = new Set(scenario.evidence.map((e) => e.id));
  for (const o of r.opinions) assert.ok(o.supportingEvidenceIds.every((id) => ids.has(id)) && o.weaknesses && o.explanation && o.title);
  assert.equal(r.telemetry?.inputTokens, 900);
});

test("both requests carry the identical scenario and evidence, run in parallel, and contain only that agent's own personality", async () => {
  const prompts: { system: string; prompt: string }[] = [];
  const release: (() => void)[] = [];
  const generate: GenerateTextFn = (_c, req) =>
    new Promise<GenerateOutcome>((resolve) => {
      prompts.push({ system: req.system, prompt: req.prompt });
      const keys: Parameters<typeof raws>[0] = prompts.length === 1 ? ["outsider", "staged", "loan"] : ["insider", "maintenance", "staged"];
      release.push(() => resolve(ok(reply(keys))));
    });
  const gen = createLlmOpinionGenerator(generate);
  const [pa, pb] = [generatePersonality(77, "A"), generatePersonality(77, "B")];
  const running = Promise.all([gen.generate({ side: "A", scenario, personality: pa }), gen.generate({ side: "B", scenario, personality: pb })]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(prompts.length, 2); // both started before either finished
  release.forEach((f) => f());
  const [a, b] = await running;
  assert.ok(a.ok && b.ok);
  const shared = (t: string) => t.slice(0, t.indexOf("YOUR REASONING TENDENCIES"));
  assert.equal(shared(prompts[0].prompt), shared(prompts[1].prompt)); // identical case, scenario and evidence
  for (const e of scenario.evidence) assert.ok(prompts[0].prompt.includes(`${e.id}: ${e.text}`) && prompts[1].prompt.includes(`${e.id}: ${e.text}`));
  assert.ok(prompts[0].prompt.includes(describePersonality(pa)) && !prompts[0].prompt.includes(describePersonality(pb)));
  assert.ok(prompts[1].prompt.includes(describePersonality(pb)) && !prompts[1].prompt.includes(describePersonality(pa)));
  // no access to the other agent's generation: neither prompt contains any opinion text of either agent
  for (const p of prompts) for (const k of Object.values(READINGS)) assert.ok(!p.prompt.includes(k.explanation) && !p.system.includes(k.explanation));
  assert.equal(prompts[0].system, prompts[1].system);
});

test("no predefined interpretation list reaches the agents: no candidates, labels or historical readings in the prompt", () => {
  const prompt = buildOpinionPrompt({ side: "A", scenario, personality: generatePersonality(5, "A") });
  assert.doesNotMatch(prompt + OPINION_SYSTEM, /CANDIDATE INTERPRETATIONS|choose from|rank the following/i);
  for (const c of PREPARED_CASES) for (const i of c.interpretations) assert.ok(!(prompt + OPINION_SYSTEM).includes(i.description) && !prompt.includes(i.label), `${c.id}/${i.id}`);
  assert.doesNotMatch(prompt, /Agent [AB]/); // no hint of the other agent or of a side
  assert.match(OPINION_SYSTEM, /EXACTLY THREE distinct/);
  assert.match(OPINION_SYSTEM, /Nobody has given you candidates: they are yours/);
});

test("the instructions define defensibility as argument strength (not truth probability), require citing real ids, and do not require disagreement", () => {
  assert.match(OPINION_SYSTEM, /argument strength, not the probability that it is true/);
  for (const a of [/0-20 cannot reasonably be defended/, /21-39 very weak/, /40-59 arguable/, /60-79 credible/, /80-100 strongly defensible/]) assert.match(OPINION_SYSTEM, a);
  assert.match(OPINION_SYSTEM, /Never invent facts, witnesses, findings or evidence ids/);
  assert.match(OPINION_SYSTEM, /you are not required to differ from anyone/);
  assert.doesNotMatch(OPINION_SYSTEM, /must (choose|pick|produce) (a )?different|disagree with the other/i);
});

test("invalid generations are rejected: wrong count, invented evidence ids, bad ranks or scores, empty fields, identical explanations", () => {
  const good = raws(["outsider", "staged", "loan"]);
  assert.ok(validateOpinions(good, scenario).ok);
  const bad: [string, unknown][] = [
    ["two opinions", good.slice(0, 2)],
    ["four opinions", [...good, ...raws(["insider", "maintenance", "outsiderParaphrase"]).slice(0, 1)]],
    ["invented evidence id", [{ ...good[0], supportingEvidenceIds: ["e1", "e99"] }, good[1], good[2]]],
    ["no evidence cited", [{ ...good[0], supportingEvidenceIds: [] }, good[1], good[2]]],
    ["duplicate evidence ids", [{ ...good[0], supportingEvidenceIds: ["e1", "e1"] }, good[1], good[2]]],
    ["repeated rank", [good[0], { ...good[1], rank: 1 }, good[2]]],
    ["rank 4", [good[0], good[1], { ...good[2], rank: 4 }]],
    ["score above 100", [{ ...good[0], selfDefensibility: 101 }, good[1], good[2]]],
    ["score as text", [{ ...good[0], selfDefensibility: "80" }, good[1], good[2]]],
    ["empty weaknesses", [{ ...good[0], weaknesses: " " }, good[1], good[2]]],
    ["short explanation", [{ ...good[0], explanation: "too short" }, good[1], good[2]]],
    ["identical explanations", [good[0], { ...good[1], explanation: good[0].explanation }, good[2]]],
    ["not a list", { opinions: good }],
  ];
  for (const [name, raw] of bad) assert.equal(validateOpinions(raw, scenario).ok, false, name);
});

test("replies are parsed leniently but validated strictly; failures are typed and carry details", async () => {
  assert.ok(parseOpinionReply("```json\n" + reply(["outsider", "staged", "loan"]) + "\n```", "B", scenario).ok);
  assert.ok(!parseOpinionReply("I would say the first one.", "B", scenario).ok);
  const invented = createLlmOpinionGenerator(async () => ok(JSON.stringify({ opinions: [{ ...raws(["outsider", "staged", "loan"])[0], supportingEvidenceIds: ["e42"] }, ...raws(["outsider", "staged", "loan"]).slice(1)] })));
  const r = await invented.generate({ side: "A", scenario, personality: generatePersonality(1, "A") });
  assert.ok(!r.ok && r.error.code === "invalid_output" && r.error.retryable && /invented evidence id/.test(r.error.details![0]));
  const down = createLlmOpinionGenerator(async (c) => ({ ok: false, error: { kind: "timeout", message: "slow", provider: c.provider, model: c.model, retryable: true } }));
  const d = await down.generate({ side: "A", scenario, personality: generatePersonality(1, "A") });
  assert.ok(!d.ok && d.error.code === "model_error" && d.error.retryable);
  const m = createMockGenerator(() => raws(["outsider", "staged", "loan"]).slice(0, 2));
  assert.ok(!(await m.generate({ side: "A", scenario, personality: generatePersonality(1, "A") })).ok);
});
