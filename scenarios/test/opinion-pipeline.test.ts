import { test } from "node:test";
import assert from "node:assert/strict";
import { startRound } from "../../ai/src/index";
import { PREPARED_SCENARIOS, createMockChecker, createMockGenerator, prepareScenario } from "../src/index";
import type { CheckResult, GenerationResult, OpinionPrepareSuccess } from "../src/index";
import { contentReport, raws, scenario } from "./opinion-fixtures";

const gen = () => createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "staged"])));
const chk = () => createMockChecker(({ opinions }) => contentReport(opinions));

test("a normal successful preparation makes exactly three requests: two parallel generations and one check", async () => {
  const g = gen();
  const c = chk();
  const r = await prepareScenario({ scenario, seed: 11, generator: g, checker: c });
  assert.ok(r.ok);
  assert.equal(r.meta.llmCalls, 3);
  assert.equal(g.requests.length, 2);
  assert.equal(c.requests.length, 1);
});

test("both generation requests carry identical public evidence, only their own personality, and nothing from the other agent", async () => {
  const g = gen();
  await prepareScenario({ scenario, seed: 12, generator: g, checker: chk() });
  const [a, b] = g.requests;
  assert.deepEqual(a.scenario, b.scenario);
  assert.notDeepEqual(a.personality, b.personality);
  assert.equal(a.side, "A");
  assert.equal(b.side, "B");
  for (const req of g.requests) assert.ok(!JSON.stringify(req).includes("selfDefensibility") && !("opinions" in req) && !("other" in req));
  assert.ok(!("interpretations" in a.scenario)); // no candidate list exists in the shared input
});

test("the checker receives six anonymised opinions and nothing that identifies an agent, and the scenario's evidence is unchanged", async () => {
  const c = chk();
  const r = await prepareScenario({ scenario, seed: 13, generator: gen(), checker: c });
  assert.ok(r.ok);
  const req = c.requests[0];
  assert.equal(req.opinions.length, 6);
  assert.deepEqual(req.scenario, scenario);
  const serial = JSON.stringify(req.opinions);
  assert.doesNotMatch(serial, /"side"|"rank"|"selfDefensibility"|"personality"|"A[123]"|"B[123]"/);
  assert.equal(Object.keys(req).sort().join(), "opinions,scenario");
});

test("the result is startRound-compatible and the locked ids point at the two opinions that were used", async () => {
  const r = await prepareScenario({ scenario, seed: 14, generator: gen(), checker: chk() });
  assert.ok(r.ok);
  const started = startRound({ roundId: "room-1:round-1", scenario: r.scenario });
  assert.ok(started.ok, started.ok ? "" : JSON.stringify(started.error));
  assert.equal(r.meta.locked.A, r.meta.selection.a.id);
  assert.equal(r.meta.locked.B, r.meta.selection.b.id);
  assert.equal(r.scenario.interpretationA, r.meta.selection.a.explanation);
  assert.equal(r.scenario.evidence.length, scenario.evidence.length);
  assert.deepEqual(r.scenario.evidence, scenario.evidence.map((e) => e.text));
});

test("the public and judge-facing payloads expose no personalities, unselected opinions or diagnostics", async () => {
  const r = (await prepareScenario({ scenario, seed: 15, generator: gen(), checker: chk() })) as OpinionPrepareSuccess;
  assert.ok(r.ok);
  const exposed = JSON.stringify({ scenario: r.scenario, publicScenario: r.publicScenario });
  for (const o of [...r.meta.generated.A, ...r.meta.generated.B]) if (o.id !== r.meta.locked.A && o.id !== r.meta.locked.B) assert.ok(!exposed.includes(o.explanation) || [r.meta.selection.a.explanation, r.meta.selection.b.explanation].includes(o.explanation), o.id);
  assert.doesNotMatch(exposed, /personality|selfDefensibility|diagnostics|checker|weaknesses|evidenceWeight|"seed"/i);
  assert.deepEqual(Object.keys(r.scenario).sort(), ["description", "evidence", "interpretationA", "interpretationB", "title"]);
  assert.ok(r.meta.personalities.A && r.meta.checkerReport && r.meta.selection.diagnostics); // kept server-side
});

test("invented evidence ids from an agent stop the preparation before any checker call", async () => {
  const bad = createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "staged", "loan"]).map((o, i) => (i === 0 ? { ...o, supportingEvidenceIds: ["e1", "e77"] } : o)) : raws(["insider", "maintenance", "staged"])));
  const c = chk();
  const r = await prepareScenario({ scenario, seed: 16, generator: bad, checker: c });
  assert.ok(!r.ok && r.stage === "generation" && r.error?.code === "invalid_output" && /invented evidence id/.test(r.error.details![0]));
  assert.equal(c.requests.length, 0);
  assert.equal(r.llmCalls, 2);
});

test("a generation failure on one side is reported with its side, and no checker request is sent", async () => {
  const half = createMockGenerator((r): GenerationResult | ReturnType<typeof raws> => (r.side === "B" ? { ok: false, error: { code: "model_error", message: "timeout", retryable: true } } : raws(["outsider", "staged", "loan"])));
  const c = chk();
  const r = await prepareScenario({ scenario, seed: 17, generator: half, checker: c });
  assert.ok(!r.ok && r.stage === "generation" && /Agent B/.test(r.message));
  assert.equal(c.requests.length, 0);
});

test("checker recovery: one repeat only after an invalid reply; a provider error is never repeated", async () => {
  let n = 0;
  const flaky = createMockChecker(({ opinions }): ReturnType<typeof contentReport> | CheckResult => (++n === 1 ? { ok: false, error: { code: "invalid_output", message: "bad json", retryable: true } } : contentReport(opinions)));
  const r = await prepareScenario({ scenario, seed: 18, generator: gen(), checker: flaky });
  assert.ok(r.ok && r.meta.llmCalls === 4 && flaky.requests.length === 2);
  const alwaysBad = createMockChecker((): CheckResult => ({ ok: false, error: { code: "invalid_output", message: "bad", retryable: true } }));
  const f = await prepareScenario({ scenario, seed: 18, generator: gen(), checker: alwaysBad });
  assert.ok(!f.ok && f.stage === "checker" && f.llmCalls === 4 && alwaysBad.requests.length === 2);
  const down = createMockChecker((): CheckResult => ({ ok: false, error: { code: "model_error", message: "503", retryable: true } }));
  const d = await prepareScenario({ scenario, seed: 18, generator: gen(), checker: down });
  assert.ok(!d.ok && d.stage === "checker" && d.llmCalls === 3 && down.requests.length === 1);
});

test("when the checker finds no credible opposing pair the preparation fails explicitly with diagnostics", async () => {
  const weak = createMockChecker(({ opinions }) => contentReport(opinions, { outsider: { defensibility: 20 }, staged: { defensibility: 20 }, loan: { defensibility: 20 }, insider: { defensibility: 20 }, maintenance: { defensibility: 20 } }));
  const r = await prepareScenario({ scenario, seed: 19, generator: gen(), checker: weak });
  assert.ok(!r.ok && r.stage === "selection" && r.selection?.reason === "no_credible_opposing_pair");
  assert.equal(r.llmCalls, 3);
});

test("the same seed and the same validated assessments reproduce the same locked pair; an invalid scenario input is rejected before any request", async () => {
  const once = await prepareScenario({ scenario, seed: 20, generator: gen(), checker: chk() });
  const twice = await prepareScenario({ scenario, seed: 20, generator: gen(), checker: chk() });
  assert.ok(once.ok && twice.ok);
  assert.deepEqual(once.meta.locked, twice.meta.locked);
  assert.deepEqual(once.meta.personalities, twice.meta.personalities);
  const g = gen();
  const bad = await prepareScenario({ scenario: { ...scenario, evidence: scenario.evidence.slice(0, 2) }, seed: 1, generator: g, checker: chk() });
  assert.ok(!bad.ok && bad.stage === "input" && bad.llmCalls === 0 && g.requests.length === 0);
});

test("every prepared case converts to a scenario-only input with stable evidence ids and no interpretations", () => {
  assert.equal(PREPARED_SCENARIOS.length, 6);
  for (const s of PREPARED_SCENARIOS) {
    assert.deepEqual(s.evidence.map((e) => e.id), s.evidence.map((_, k) => `e${k + 1}`));
    assert.ok(!("interpretations" in s));
  }
});
