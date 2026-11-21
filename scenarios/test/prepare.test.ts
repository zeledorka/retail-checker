import { test } from "node:test";
import assert from "node:assert/strict";
import { startRound } from "../../ai/src/index";
import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { PREPARED_CASES, buildRankingPrompt, createLlmRanker, createMockRanker, createSeededMockRanker, describePersonality, generatePersonality, generateScenarioBatch, parseRankingReply, prepareFromPool, prepareRound } from "../src/index";
import type { OpinionRequest, RawRankingItem, ScenarioCase } from "../src/index";
import { runMockPreparation } from "../examples/mock-preparation";

const c = PREPARED_CASES[0]; // empty-display-case: opportunistic-theft, staged-theft, handling-error, personal-motive-insider
const ids = c.interpretations.map((i) => i.id);
const it = (id: string, rank: number, defensibility: number): RawRankingItem => ({ id, rank, defensibility, explanation: `grounded in the evidence for ${id}` });
const bySide = (a: RawRankingItem[], b: RawRankingItem[]) => createMockRanker((r) => (r.side === "A" ? a : b));
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
  return r as Extract<T, { ok: true }>;
};

test("opposing top choices are locked: A defends its first choice, B defends its own, exactly two requests, no third", async () => {
  const ranker = bySide([it(ids[0], 1, 90), it(ids[2], 2, 70)], [it(ids[1], 1, 85), it(ids[3], 2, 66)]);
  const r = ok(await prepareRound({ scenarioCase: c, seed: 5, ranker }));
  assert.equal(ranker.requests.length, 2); // one ranking per agent; the selection itself makes no model call
  assert.deepEqual(r.meta.locked, { A: ids[0], B: ids[1] });
  assert.equal(r.scenario.interpretationA, c.interpretations[0].description);
  assert.equal(r.scenario.interpretationB, c.interpretations[1].description);
});

test("both agents ranking the same interpretation first still yields a credible opposing pair when one exists", async () => {
  const ranker = bySide([it(ids[1], 1, 92), it(ids[0], 2, 78)], [it(ids[1], 1, 90), it(ids[2], 2, 75)]);
  const r = ok(await prepareRound({ scenarioCase: c, seed: 5, ranker, selection: { tieMargin: 0 } }));
  assert.notEqual(r.meta.locked.A, r.meta.locked.B);
  assert.deepEqual(r.meta.locked, { A: ids[0], B: ids[1] }); // (A second choice, B first choice) = 78+90+3+10 = 181 beats (A first, B second) = 92+75+10+3 = 180
  assert.ok(r.meta.selection.diagnostics.pairsSameInterpretation >= 1);
});

test("no credible opposing choice: an explicit selection failure, nothing forced", async () => {
  const ranker = bySide([it(ids[1], 1, 90), it(ids[0], 2, 44)], [it(ids[1], 1, 88), it(ids[2], 2, 30)]);
  const r = await prepareRound({ scenarioCase: c, seed: 5, ranker });
  assert.ok(!r.ok);
  assert.equal(r.stage, "selection");
  assert.equal(r.selection?.ok, false);
  assert.ok(!r.selection?.ok && r.selection?.reason === "no_credible_opposing_pair");
  assert.match(r.message, /no_credible_opposing_pair/);
});

test("invented or duplicate interpretation ids from a ranker fail the selection stage with the offending side", async () => {
  const r1 = await prepareRound({ scenarioCase: c, seed: 5, ranker: bySide([it("made-up", 1, 90)], [it(ids[1], 1, 90)]) });
  assert.ok(!r1.ok && r1.stage === "selection" && r1.selection && !r1.selection.ok && r1.selection.side === "A");
  const r2 = await prepareRound({ scenarioCase: c, seed: 5, ranker: bySide([it(ids[0], 1, 90)], [it(ids[1], 1, 90), it(ids[1], 2, 80)]) });
  assert.ok(!r2.ok && r2.stage === "selection" && r2.selection && !r2.selection.ok && r2.selection.side === "B");
});

test("ranker failures are reported with the stage and the error, and an invalid case never reaches a model", async () => {
  const failing = createMockRanker((req) => (req.side === "A" ? { ok: false, error: { code: "model_error", message: "timeout", retryable: true } } : [it(ids[1], 1, 90)]));
  const r = await prepareRound({ scenarioCase: c, seed: 1, ranker: failing });
  assert.ok(!r.ok && r.stage === "ranking" && r.rankingError?.retryable === true && /Agent A/.test(r.message));
  const never = createMockRanker(() => []);
  const bad = await prepareRound({ scenarioCase: { ...c, evidence: [] }, seed: 1, ranker: never });
  assert.ok(!bad.ok && bad.stage === "scenario");
  assert.equal(never.requests.length, 0);
});

test("independent contexts: each live-ranker request holds the shared case and candidates plus ONLY its own personality", async () => {
  const prompts: { system: string; prompt: string }[] = [];
  const releases: (() => void)[] = [];
  const generate: GenerateTextFn = (_cfg, req) =>
    new Promise<GenerateOutcome>((resolve) => {
      prompts.push({ system: req.system, prompt: req.prompt });
      const side = prompts.length === 1 ? "first" : "second";
      releases.push(() => resolve({ ok: true, result: { text: JSON.stringify({ ranking: [{ id: side === "first" ? ids[0] : ids[1], rank: 1, defensibility: 88, explanation: "ok" }] }), provider: "anthropic", model: "claude-sonnet-5-5", latencyMs: 5 } }));
    });
  const running = prepareRound({ scenarioCase: c, seed: 4242, ranker: createLlmRanker(generate) });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(prompts.length, 2); // both requests were started before either finished: they run in parallel
  releases.forEach((f) => f());
  const r = ok(await running);
  const [pa, pb] = [generatePersonality(4242, "A"), generatePersonality(4242, "B")];
  const [textA, textB] = [prompts[0].prompt, prompts[1].prompt];
  assert.ok(textA.includes(describePersonality(pa)) && !textA.includes(describePersonality(pb)));
  assert.ok(textB.includes(describePersonality(pb)) && !textB.includes(describePersonality(pa)));
  const shared = (t: string) => t.slice(0, t.indexOf("YOUR REASONING TENDENCIES"));
  assert.equal(shared(textA), shared(textB)); // identical scenario, evidence and candidate ids and descriptions
  for (const i of c.interpretations) assert.ok(shared(textA).includes(`${i.id} | ${i.label}: ${i.description}`));
  for (const e of c.evidence) assert.ok(shared(textA).includes(e));
  for (const p of prompts) assert.doesNotMatch(p.prompt + p.system, /Agent [AB]|ranking of the other|opponent/i); // no side labels, no hint of the other agent
  assert.match(prompts[0].system, /defensibility/);
  assert.match(prompts[0].system, /not a probability/);
  assert.equal(r.meta.rankingTelemetry.A?.model, "claude-sonnet-5-5");
});

test("the live ranker adapter uses Claude Sonnet 5.5 and maps replies and failures", async () => {
  const models: string[] = [];
  const reply = (text: string): GenerateTextFn => async (cfg) => (models.push(cfg.model), { ok: true, result: { text, provider: "anthropic", model: cfg.model, latencyMs: 1 } });
  const req: OpinionRequest = { side: "A", scenario: { title: c.title, description: c.description, evidence: c.evidence }, candidates: c.interpretations, personality: generatePersonality(1, "A") };
  const good = await createLlmRanker(reply('```json\n{"ranking":[{"id":"staged-theft","rank":1,"defensibility":80,"explanation":"x"}]}\n```')).rank(req);
  assert.ok(good.ok && good.rankings[0].id === "staged-theft");
  assert.deepEqual(models, ["claude-sonnet-5-5"]);
  const junk = await createLlmRanker(reply("I think the first one.")).rank(req);
  assert.ok(!junk.ok && junk.error.code === "invalid_output" && junk.error.retryable);
  const down = await createLlmRanker(async (cfg) => ({ ok: false, error: { kind: "timeout", message: "slow", provider: cfg.provider, model: cfg.model, retryable: true } })).rank(req);
  assert.ok(!down.ok && down.error.code === "model_error" && down.error.retryable);
  assert.ok(!parseRankingReply("{").ok && !parseRankingReply('{"x":1}').ok);
  assert.match(buildRankingPrompt(req), /YOUR REASONING TENDENCIES/);
});

test("the locked scenario is exactly what the AI round accepts, for every prepared case", async () => {
  for (const [n, sc] of PREPARED_CASES.entries()) {
    const r = ok(await prepareRound({ scenarioCase: sc, seed: 100 + n, ranker: createSeededMockRanker() }).then((x) => (x.ok ? x : prepareRound({ scenarioCase: sc, seed: 900 + n, ranker: createSeededMockRanker() })))).scenario;
    const started = startRound({ roundId: `room-${n}:round-1`, scenario: r });
    assert.ok(started.ok, sc.id);
    assert.deepEqual(started.state.scenario, r); // the AI subsystem keeps the locked interpretations untouched
    assert.deepEqual(Object.keys(r).sort(), ["description", "evidence", "interpretationA", "interpretationB", "title"]);
  }
});

test("private metadata is kept server-side: the scenario and the public view carry no personality, ranking or candidate list", async () => {
  const r = ok(await prepareRound({ scenarioCase: c, seed: 31, ranker: bySide([it(ids[0], 1, 91), it(ids[1], 2, 71)], [it(ids[1], 1, 87), it(ids[2], 2, 64)]) }));
  const exposed = JSON.stringify([r.scenario, r.publicScenario]);
  assert.doesNotMatch(exposed, /seed|personality|scepticism|defensibility|grounded in the evidence|candidates|rank/i);
  assert.ok(exposed.includes(c.interpretations[0].description));
  assert.ok(!exposed.includes(c.interpretations[3].description)); // unselected candidates stay out
  const m = r.meta;
  assert.equal(m.seed, 31);
  assert.deepEqual(m.personalities.A, generatePersonality(31, "A"));
  assert.deepEqual(m.rankings.A.map((x) => x.id), [ids[0], ids[1]]);
  assert.equal(m.candidates.length, 4);
  assert.equal(m.selection.diagnostics.pairsConsidered, 4);
  assert.deepEqual(m.locked, { A: ids[0], B: ids[1] });
});

test("the same seed reproduces the whole preparation; other seeds vary the sides and the pair", async () => {
  const run = (seed: number) => prepareRound({ scenarioCase: c, seed, ranker: createSeededMockRanker() });
  const a = await run(2024);
  const b = await run(2024);
  assert.deepEqual(a, b);
  const pairs = new Set<string>();
  const sidesSwapped = new Set<string>();
  const personalityAs = new Set<number>();
  for (let seed = 1; seed <= 80; seed++) {
    const r = await run(seed);
    if (!r.ok) continue;
    pairs.add(`${r.meta.locked.A}|${r.meta.locked.B}`);
    sidesSwapped.add([r.meta.locked.A, r.meta.locked.B].sort().join("+") + (r.meta.locked.A < r.meta.locked.B ? ":asc" : ":desc"));
    personalityAs.add(r.meta.personalities.A.evidenceScepticism);
  }
  assert.ok(pairs.size >= 5, `only ${pairs.size} distinct (A,B) arrangements in 80 runs`); // not one fixed arrangement
  assert.ok([...sidesSwapped].some((k) => k.endsWith(":asc")) && [...sidesSwapped].some((k) => k.endsWith(":desc"))); // both orders occur: no fixed side assignment
  assert.ok(personalityAs.size > 40);
});

test("a pool falls back to another prepared case when one has no credible opposing pair", async () => {
  const calls: string[] = [];
  const ranker = createMockRanker((req) => {
    calls.push(req.scenario.title);
    const cand = req.candidates.map((x) => x.id);
    // the first case offered: both agents only credibly back one interpretation; any later case: two different credible opinions
    return req.scenario.title === calls[0] ? [it(cand[0], 1, 90), it(cand[1], 2, 40)] : req.side === "A" ? [it(cand[0], 1, 90)] : [it(cand[1], 1, 85)];
  });
  const r = await prepareFromPool({ cases: PREPARED_CASES, seed: 8, ranker });
  assert.ok(r.ok);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].stage, "selection");
  assert.equal(ranker.requests.length, 4); // two failed requests + two on the case that worked
  assert.notEqual(r.result.meta.scenarioId, r.failures[0].scenarioId);
  const none = await prepareFromPool({ cases: PREPARED_CASES, seed: 8, ranker: createMockRanker(() => [it("a", 1, 10)]), maxAttempts: 2 });
  assert.ok(!none.ok && none.failures.length === 2);
  assert.ok(!(await prepareFromPool({ cases: PREPARED_CASES.slice(0, 1), seed: 1, ranker, excludeIds: [PREPARED_CASES[0].id] })).ok); // an excluded case is never attempted
});

test("batch generation validates every structured reply and reports what it rejects", async () => {
  const valid = (id: string): ScenarioCase => ({ ...PREPARED_CASES[1], id, title: `Case ${id}`, interpretations: PREPARED_CASES[1].interpretations });
  const replies = [JSON.stringify(valid("gen-one")), "not json at all", JSON.stringify({ ...valid("gen-three"), evidence: ["only one"] }), JSON.stringify(valid("gen-one")), JSON.stringify(valid("gen-five"))];
  let n = 0;
  const generate: GenerateTextFn = async (cfg) => ({ ok: true, result: { text: replies[n++], provider: "anthropic", model: cfg.model, latencyMs: 1 } });
  const batch = await generateScenarioBatch({ generate, count: 5, seed: 3 });
  assert.deepEqual(batch.cases.map((x) => x.id), ["gen-one", "gen-five"]);
  assert.deepEqual(batch.rejected.map((x) => x.index), [1, 2, 3]);
  assert.match(batch.rejected[0].errors[0], /not valid JSON/);
  assert.match(batch.rejected[2].errors[0], /duplicate case id/);
  assert.equal(n, 5); // one structured request per case, no retries
});

test("the mocked end-to-end example prepares a locked scenario that the AI round accepts, with no network", async () => {
  const r = await runMockPreparation(777);
  assert.ok(r.ok);
  assert.ok(r.round.ok);
  assert.equal(r.modelRequests % 2, 0);
  assert.notEqual(r.meta.locked.A, r.meta.locked.B);
  assert.equal(r.round.state.scenario.interpretationA, r.scenario.interpretationA);
});
