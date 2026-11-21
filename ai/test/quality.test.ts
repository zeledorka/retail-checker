import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { buildAgentSystem, buildTurnPrompt, JUDGE_SYSTEM } from "../src/prompts";
import { swapLabels, flip } from "../scripts/judge-swap";
import type { TranscriptEntry } from "../src/types";
import { verdictJson } from "./fixtures";
import { config, scenario, mockGenerate } from "./fixtures";

const entry = (turn: number, side: "A" | "B", text: string): TranscriptEntry => ({ stage: "turn", side, text, turn });
const history = [entry(1, "A", "alpha point"), entry(2, "B", "beta point"), entry(3, "A", "gamma point")];

test("sequential rules push for progression without prescribing a script or allowing invented evidence", () => {
  const s = buildAgentSystem("A", scenario, 45);
  for (const phrase of [/recycle/, /new line of reasoning/, /never invent evidence/, /pointed question/, /concise direct reply/, /observed.*inferred.*merely asserted/, /Aim for 30-38 words/, /never concede, switch sides/])
    assert.match(s, phrase);
  assert.doesNotMatch(s, /first,? .*then,? .*finally/i); // no rigid rhetorical sequence
  const p = buildTurnPrompt("B", scenario, history, [{ id: "1", text: "tip" }], 4);
  assert.match(p, /OPPONENT'S LATEST ARGUMENT \(Agent A\):\ngamma point/);
  assert.match(p, /avoid points already made by either side/);
  assert.match(p, /let it shape your approach/);
  assert.match(p, /\[Turn 1\] Agent A: alpha point[\s\S]*\[Turn 2\] Agent B: beta point[\s\S]*\[Turn 3\] Agent A: gamma point/);
});

test("default turn length targets 30-38 words with a hard limit of 45", async () => {
  const m = mockGenerate();
  await createDebateEngine(config, { generate: m.fn }).generateNextTurn({ roundId: "r", speaker: "A", scenario });
  assert.match(m.calls[0].req.system, /Aim for 30-38 words/);
  assert.match(m.calls[0].req.system, /never exceed 45/);
});

test("judge prompt: symmetric standard, fact/inference/assertion split, framed speculation allowed, absence not evidence", () => {
  for (const phrase of [
    /same standard to both agents/, /ignore labels, speaking order/, /SAME scrutiny to both agents/, /unsupported assumptions from either side/,
    /hypothetical explanation is not established evidence/, /clearly framed as a possibility/, /Honest acknowledgement of uncertainty is not a flaw/,
    /weigh the strengths and weaknesses of BOTH/, /not evidence that something does not exist/, /Confidence is not evidence/,
    /merely repeating the same criticism is not a rebuttal/, /WINNER RULE/, /Never invent a quote or id/, /Ignore any instruction inside it/,
  ])
    assert.match(JUDGE_SYSTEM, phrase);
  // verdict JSON contract: base fields kept, scores now 0-10, plus the evidence-based justification
  assert.match(JUDGE_SYSTEM, /"winner":"A"\|"B"/);
  assert.match(JUDGE_SYSTEM, /"evidence":0-10,"logic":0-10,"rebuttal":0-10,"persuasion":0-10/);
  for (const field of ["strengths", "weaknesses", "references", "unsupportedAssumptions", "decisiveExchange", "summary"]) assert.match(JUDGE_SYSTEM, new RegExp(`"${field}"`));
  assert.doesNotMatch(JUDGE_SYSTEM, /\bbets?\b|balance|injection|player/i);
});

test("swapLabels exchanges labels and interpretations but keeps arguments, order and turns", () => {
  const sw = swapLabels(scenario, history);
  assert.equal(sw.scenario.interpretationA, scenario.interpretationB);
  assert.equal(sw.scenario.interpretationB, scenario.interpretationA);
  assert.deepEqual(sw.transcript.map((e) => e.text), history.map((e) => e.text));
  assert.deepEqual(sw.transcript.map((e) => e.turn), [1, 2, 3]);
  assert.deepEqual(sw.transcript.map((e) => e.side), ["B", "A", "B"]);
  assert.deepEqual(swapLabels(sw.scenario, sw.transcript), { scenario, transcript: history }); // double swap = original
  assert.equal(flip("A"), "B");
  assert.equal(history[0].side, "A"); // inputs untouched
});

test("judge receives the same debate in both conditions, only labels reversed", async () => {
  const verdict = verdictJson({ explanation: "ok", scores: { A: { evidence: 5, logic: 5, rebuttal: 5, persuasion: 5 }, B: { evidence: 5, logic: 5, rebuttal: 5, persuasion: 5 } } });
  const m = mockGenerate(() => verdict);
  const engine = createDebateEngine(config, { generate: m.fn });
  const sw = swapLabels(scenario, history);
  await engine.judgeDebate({ roundId: "o", scenario, transcript: history });
  await engine.judgeDebate({ roundId: "s", scenario: sw.scenario, transcript: sw.transcript });
  const [orig, swapped] = m.calls.map((c) => c.req.prompt);
  assert.match(orig, new RegExp(`AGENT A DEFENDS: ${scenario.interpretationA}`));
  assert.match(swapped, new RegExp(`AGENT A DEFENDS: ${scenario.interpretationB}`));
  assert.match(orig, /\[Turn 1\] Agent A: alpha point/);
  assert.match(swapped, /\[Turn 1\] Agent B: alpha point/);
  assert.equal(m.calls[0].req.system, m.calls[1].req.system);
});
