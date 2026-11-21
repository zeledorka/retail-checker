import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeRound, startRound } from "../../ai/src/index";
import { createMockChecker, createMockGenerator, prepareNewRound } from "../src/index";
import type { GenerationResult, ImageResult } from "../src/index";
import { DESIGNS, PNG_B64, designed, mockChecker, mockImage, mockOpinions, pngResult, scenarioWriter } from "./full-fixtures";
import { contentReport, raws } from "./opinion-fixtures";

const run = (over: Partial<Parameters<typeof prepareNewRound>[0]> = {}) => {
  const writer = scenarioWriter();
  const generator = mockOpinions();
  const checker = mockChecker();
  const imageGenerator = mockImage();
  return { writer, generator, checker, imageGenerator, p: prepareNewRound({ seed: 77, generate: writer, generator, checker, imageGenerator, ...over }) };
};

test("the normal path makes exactly five provider requests with no duplicates: 1 scenario, 1 image, 2 opinion generations, 1 checker", async () => {
  const t = run();
  const r = await t.p;
  assert.ok(r.ok && r.source === "generated");
  assert.equal(t.writer.prompts.length, 1);
  assert.equal(t.imageGenerator.calls.length, 1);
  assert.equal(t.generator.requests.length, 2);
  assert.equal(t.checker.requests.length, 1);
  assert.deepEqual(r.server.requests, { scenario: 1, image: 1, opinionGeneration: 2, checker: 1, total: 5 });
});

test("image generation and opinion preparation run concurrently: both have started before either finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started: string[] = [];
  const imageGenerator = { async generate(req: { scenario: Parameters<ReturnType<typeof mockImage>["generate"]>[0]["scenario"] }): Promise<ImageResult> { started.push("image"); await gate; return pngResult(req.scenario); } };
  const generator = createMockGenerator((r) => { started.push(`gen-${r.side}`); return r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "rival"]); });
  const p = prepareNewRound({ seed: 5, generate: scenarioWriter(), generator, checker: mockChecker(), imageGenerator });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(started.includes("image") && started.includes("gen-A") && started.includes("gen-B"), `started: ${started}`);
  release();
  const r = await p;
  assert.ok(r.ok);
  assert.ok(r.server.timing.parallelMs! >= 0 && r.server.timing.totalMs >= r.server.timing.parallelMs!);
});

test("the image sees only public facts and the opinion agents never see the private designs or image prompt", async () => {
  const t = run();
  const r = await t.p;
  assert.ok(r.ok);
  assert.ok(t.imageGenerator.calls[0].prompt.includes(t.imageGenerator.calls[0].scenario.imagePrompt!));
  const seenByAgents = JSON.stringify([...t.generator.requests, ...t.checker.requests]);
  for (const d of DESIGNS) assert.ok(!seenByAgents.includes(d.mechanism) && !seenByAgents.includes(d.label));
  assert.ok(!seenByAgents.includes("imagePrompt") && !seenByAgents.includes("warm low light"));
  for (const d of DESIGNS) assert.ok(!t.imageGenerator.calls[0].prompt.includes(d.mechanism));
});

test("the complete package: two locked interpretations, startRound compatible, public/private separation, image bytes kept out of JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "round-"));
  try {
    const r = await run({ saveImagesTo: dir }).p;
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.scenario).sort(), ["description", "evidence", "interpretationA", "interpretationB", "title"]);
    assert.notEqual(r.scenario.interpretationA, r.scenario.interpretationB);
    assert.equal(r.publicCase.interpretationA, r.scenario.interpretationA);
    assert.equal(r.server.opinions.locked.A.startsWith("A"), true);
    const started = startRound({ roundId: "room-1:round-1", scenario: r.scenario });
    assert.ok(started.ok, started.ok ? "" : JSON.stringify(started.error));
    const stateJson = started.ok ? serializeRound(started.state) : "";
    assert.ok(!stateJson.includes(PNG_B64) && !stateJson.includes("bytes"));
    assert.ok(r.image && r.image.bytes.byteLength > 0 && r.image.mimeType === "image/png");
    assert.equal(r.publicCase.image?.mimeType, "image/png");
    const publicJson = JSON.stringify(r.publicCase) + JSON.stringify(r.scenario);
    assert.ok(!publicJson.includes(PNG_B64));
    assert.doesNotMatch(publicJson, /personality|selfDefensibility|diagnostics|designs|mechanism|checker|"seed"/i);
    for (const d of DESIGNS) assert.ok(!publicJson.includes(d.mechanism));
    assert.ok(r.server.design?.designs.length === 3 && r.server.opinions.personalities.A && r.server.opinions.checkerReport && r.server.opinions.selection.diagnostics);
    assert.ok(r.publicCase.localImagePath && existsSync(r.publicCase.localImagePath));
    assert.equal(r.server.models.image, "google/gemini-3.1-flash-lite-image");
    assert.equal(r.server.models.scenario, "claude-sonnet-5-5");
    assert.ok(r.server.usage.estimatedClaudeUsd > 0 && r.server.usage.imageCostUsd === 0.031);
    assert.equal(readFileSync(r.publicCase.localImagePath).byteLength, r.image.byteLength);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an opinion failure writes a NEW scenario (bounded); a failed scenario is never forced into a debate", async () => {
  let n = 0;
  const generator = createMockGenerator((r): GenerationResult | ReturnType<typeof raws> => (++n <= 2 ? { ok: false, error: { code: "insufficient_diversity", message: "only one reading", retryable: false } } : r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "rival"])));
  const writer = scenarioWriter();
  const r = await prepareNewRound({ seed: 9, generate: writer, generator, checker: mockChecker(), imageGenerator: mockImage() });
  assert.ok(r.ok);
  assert.equal(writer.prompts.length, 2);
  assert.notEqual(r.server.attempts[0].seed, r.server.attempts[1].seed);
  assert.equal(r.server.attempts[0].ok, false);
  assert.equal(r.server.requests.scenario, 2);
  const single = await prepareNewRound({ seed: 9, generate: scenarioWriter(), generator: createMockGenerator(() => ({ ok: false, error: { code: "insufficient_diversity", message: "x", retryable: false } })), checker: mockChecker(), imageGenerator: mockImage(), maxScenarioAttempts: 1 });
  assert.ok(!single.ok && single.stage === "opinions" && /fewer than three distinct/.test(single.message));
  const noPair = await prepareNewRound({ seed: 9, generate: scenarioWriter(), generator: mockOpinions(), checker: createMockChecker(({ opinions }) => contentReport(opinions, { outsider: { defensibility: 10 }, staged: { defensibility: 10 }, loan: { defensibility: 10 }, insider: { defensibility: 10 }, maintenance: { defensibility: 10 }, rival: { defensibility: 10 } })), imageGenerator: mockImage(), maxScenarioAttempts: 2 });
  assert.ok(!noPair.ok && noPair.stage === "opinions" && noPair.attempts.length === 2 && /no credible|no meaningful/i.test(noPair.attempts[1].message ?? ""));
});

test("an invalid scenario is retried with a new scenario request, up to the bound; no image or opinion request is made for it", async () => {
  const writer = scenarioWriter((n) => (n === 0 ? "not json" : designed()));
  const t = run({ generate: writer });
  const r = await t.p;
  assert.ok(r.ok && writer.prompts.length === 2);
  assert.equal(t.imageGenerator.calls.length, 1);
  const allBad = await prepareNewRound({ seed: 1, generate: scenarioWriter(() => "nope"), generator: mockOpinions(), checker: mockChecker(), imageGenerator: mockImage(), maxScenarioAttempts: 2 });
  assert.ok(!allBad.ok && allBad.stage === "scenario" && allBad.requests.scenario === 2 && allBad.requests.image === 0 && allBad.requests.total === 2);
});

test("an image failure retries ONLY the image: the three opinion requests are never repeated", async () => {
  const t = run({ imageGenerator: mockImage((n) => (n === 0 ? { ok: false, error: { code: "http_error", message: "502", retryable: true, status: 502 } } : undefined)) });
  const r = await t.p;
  assert.ok(r.ok);
  assert.equal(t.generator.requests.length, 2);
  assert.equal(t.checker.requests.length, 1);
  assert.equal(r.server.requests.image, 2);
  assert.equal(r.server.requests.total, 6);
  // a non-retryable image failure returns the finished work so the caller can retry the image alone
  const gen = mockOpinions();
  const chk = mockChecker();
  const f = await prepareNewRound({ seed: 3, generate: scenarioWriter(), generator: gen, checker: chk, imageGenerator: mockImage(() => ({ ok: false, error: { code: "unsupported_model", message: "gone", retryable: false } })) });
  assert.ok(!f.ok && f.stage === "image" && f.preserved?.opinions.ok);
  assert.equal(gen.requests.length, 2);
  assert.equal(chk.requests.length, 1);
  assert.equal(f.requests.image, 1);
});

test("the prepared-case fallback is explicit: no generated image is claimed, and it is used only when asked for", async () => {
  const badWriter = scenarioWriter(() => "nope");
  const without = await prepareNewRound({ seed: 4, generate: badWriter, generator: mockOpinions(), checker: mockChecker(), imageGenerator: mockImage(), maxScenarioAttempts: 1 });
  assert.ok(!without.ok);
  const t = run({ generate: scenarioWriter(() => "nope"), maxScenarioAttempts: 1, fallbackToPrepared: true });
  const r = await t.p;
  assert.ok(r.ok && r.source === "fallback");
  assert.equal(r.image, null);
  assert.equal(r.publicCase.image, null);
  assert.equal(r.server.imageStatus, "fallback_without_image");
  assert.equal(t.imageGenerator.calls.length, 0);
  assert.ok(startRound({ roundId: "r", scenario: r.scenario }).ok);
  assert.equal(r.server.design, undefined);
});

test("a missing image key surfaces as a typed image failure without repeating any opinion request", async () => {
  const { createOpenRouterImageGenerator } = await import("../src/index");
  const gen = mockOpinions();
  const r = await prepareNewRound({ seed: 6, generate: scenarioWriter(), generator: gen, checker: mockChecker(), imageGenerator: createOpenRouterImageGenerator({ env: {}, fetchFn: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch }) });
  assert.ok(!r.ok && r.stage === "image" && r.lastError?.code === "missing_key");
  assert.equal(gen.requests.length, 2);
});
