import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import type { AudienceInjection } from "../src/types";
import { config, scenario, fullTranscript, mockGenerate } from "./fixtures";

test("opening: both agents called in parallel with their own model configs", async () => {
  const m = mockGenerate();
  const r = await createDebateEngine(config, { generate: m.fn }).generateOpeningArguments({ roundId: "r1", scenario });
  assert.ok(r.ok);
  assert.equal(m.calls.length, 2);
  assert.equal(r.arguments.A.meta.model, "mock-claude");
  assert.equal(r.arguments.B.meta.provider, "openrouter");
  assert.equal(r.arguments.A.key, "r1:opening:A");
});

test("rebuttal requires both opening arguments", async () => {
  const m = mockGenerate();
  const r = await createDebateEngine(config, { generate: m.fn }).generateRebuttals({ roundId: "r1", scenario, transcript: fullTranscript.slice(0, 1) });
  assert.equal(r.ok, false);
  assert.equal(m.calls.length, 0);
  assert.ok(!r.ok && r.errors.A?.kind === "missing_history");
});

test("injections route only to their agent and window; later-stage text is not leaked", async () => {
  const injections: AudienceInjection[] = [
    { id: "a1", side: "A", window: 1, text: "mention the crumbs", submittedAt: 1 },
    { id: "b1", side: "B", window: 1, text: "stress the alibi", submittedAt: 2 },
    { id: "a2", side: "A", window: 2, text: "closing-only tip", submittedAt: 3 },
  ];
  const m = mockGenerate();
  const r = await createDebateEngine(config, { generate: m.fn }).generateRebuttals({ roundId: "r1", scenario, transcript: fullTranscript, injections });
  assert.ok(r.ok);
  const promptFor = (model: string) => m.calls.find((c) => c.cfg.model === model)!.req.prompt;
  assert.match(promptFor("mock-claude"), /mention the crumbs/);
  assert.doesNotMatch(promptFor("mock-claude"), /stress the alibi|closing-only tip/);
  assert.match(promptFor("mock/deepseek"), /stress the alibi/);
  assert.doesNotMatch(promptFor("mock-claude"), /rebuttal text|closing text/); // only earlier stages visible
  assert.deepEqual(r.arguments.A.injectionIdsUsed, ["a1"]);
});

test("one agent failing returns structured error and keeps the other argument", async () => {
  const m = mockGenerate((c) => (c.model === "mock/deepseek" ? new Error("timed out") : "ok"));
  const r = await createDebateEngine(config, { generate: m.fn }).generateOpeningArguments({ roundId: "r1", scenario });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.arguments.A && !r.arguments.B && r.errors.B?.kind === "timeout");
});

test("onModelCall hook receives every call and cannot break the stage", async () => {
  const m = mockGenerate();
  let n = 0;
  const engine = createDebateEngine(config, { generate: m.fn, onModelCall: () => { n++; throw new Error("logger broke"); } });
  const r = await engine.generateOpeningArguments({ roundId: "r1", scenario });
  assert.ok(r.ok);
  assert.equal(n, 2);
});
