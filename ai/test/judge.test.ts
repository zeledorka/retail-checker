import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { config, scenario, fullTranscript, mockGenerate } from "./fixtures";

const verdict = JSON.stringify({
  winner: "A", explanation: "A tied crumbs to Dave.",
  scores: { A: { evidence: 8, logic: 7, rebuttal: 7, persuasion: 8 }, B: { evidence: 6, logic: 6, rebuttal: 5, persuasion: 6 } },
});

test("judge returns validated verdict using the judge model", async () => {
  const m = mockGenerate(() => verdict);
  const r = await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r9", scenario, transcript: fullTranscript });
  assert.ok(r.ok && r.verdict.winner === "A" && r.key === "r9:verdict");
  assert.equal(m.calls[0].cfg.model, "mock-judge");
});

test("judge input contains only public transcript fields", async () => {
  const m = mockGenerate(() => verdict);
  const leaky = fullTranscript.map((e) => ({ ...e, betTotal: 999, injections: ["SECRET_TIP"] }));
  await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r9", scenario, transcript: leaky });
  assert.doesNotMatch(m.calls[0].req.prompt, /SECRET_TIP|999/);
});

test("invalid judge JSON retries once then fails without inventing a winner", async () => {
  const m = mockGenerate(() => "Both were great, it's a tie!");
  const r = await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r9", scenario, transcript: fullTranscript });
  assert.equal(m.calls.length, 2);
  assert.ok(!r.ok && r.error.kind === "invalid_output" && r.attempts === 2);
});

test("judge refuses to run on an incomplete transcript", async () => {
  const m = mockGenerate(() => verdict);
  const r = await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r9", scenario, transcript: fullTranscript.slice(0, 4) });
  assert.ok(!r.ok && r.error.kind === "missing_history");
  assert.equal(m.calls.length, 0);
});
