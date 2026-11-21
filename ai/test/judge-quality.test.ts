import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { parseVerdict, ruleWinner } from "../src/judge";
import { JUDGE_SYSTEM, judgeEntries } from "../src/prompts";
import type { TranscriptEntry } from "../src/types";
import { config, scenario, mockGenerate, verdictJson } from "./fixtures";

const transcript: TranscriptEntry[] = [
  { stage: "opening", side: "A", text: "The alarm sounding makes a staged theft unlikely, because a thief avoids attention." },
  { stage: "opening", side: "B", text: "A deliberately triggered alarm creates an official incident timeline for an insurance claim." },
  { stage: "turn", side: "A", turn: 3, text: "B assumes motive from a renewal date, but timing is not intent." },
  { stage: "turn", side: "B", turn: 4, text: "I do not claim intent proved; I say the logbook gap is unexplained and remains open." },
];
const entries = judgeEntries(transcript);
const sc = (e: number, l: number, r: number, p: number) => ({ evidence: e, logic: l, rebuttal: r, persuasion: p });
const parse = (over: Record<string, unknown> = {}) => parseVerdict(verdictJson(over), entries);
const refs = (...r: object[]) => ({ references: r });

test("entries get chronological ids E1..En and the judge prompt shows them with the public text only", async () => {
  assert.deepEqual(entries.map((e) => [e.id, e.side]), [["E1", "A"], ["E2", "B"], ["E3", "A"], ["E4", "B"]]);
  const m = mockGenerate(() => verdictJson());
  const leaky = transcript.map((e) => ({ ...e, injections: ["PRIVATE-TIP"], betTotal: 77, groups: ["SECRET-GROUP"] }));
  await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r", scenario, transcript: leaky });
  assert.match(m.calls[0].req.prompt, /\[E3\] \[Turn 3\] Agent A: B assumes motive/);
  assert.doesNotMatch(m.calls[0].req.prompt, /PRIVATE-TIP|SECRET-GROUP|77|supporters|audience/i);
  assert.equal(m.calls.length, 1); // one judging request
});

test("the four dimensions are scored independently (0-10) and overall is computed by the engine, not the model", () => {
  const r = parse({ scores: { A: sc(9, 4, 8, 6), B: sc(5, 7, 3, 9) }, overall: { A: 10, B: 10 } });
  assert.ok(r.ok);
  assert.deepEqual(r.verdict.scores.A, sc(9, 4, 8, 6));
  assert.deepEqual(r.verdict.overall, { A: 6.8, B: 6 }); // means of the four; the model's claimed overall is ignored
  assert.equal(parse({ scores: { A: sc(11, 5, 5, 5), B: sc(5, 5, 5, 5) } }).ok, false); // out of range
  assert.equal(parse({ scores: { A: sc(0, 0, 0, 0), B: sc(0, 0, 0, 0) }, winner: "A" }).ok, true); // 0 is a legal score
  assert.match(JUDGE_SYSTEM, /INDEPENDENTLY/);
});

test("a persuasive but unsupported argument does not automatically win: persuasion is only one of four scores", () => {
  const b = parse({ winner: "B", scores: { A: sc(8, 8, 7, 5), B: sc(3, 4, 5, 10) } });
  assert.equal(b.ok, false); // B's totals are lower (22 vs 28): declaring B the winner contradicts the scores
  assert.ok(!b.ok && /contradicts the scores/.test(b.reason));
  const a = parse({ winner: "A", scores: { A: sc(8, 8, 7, 5), B: sc(3, 4, 5, 10) } });
  assert.ok(a.ok && a.verdict.winner === "A");
});

test("winner rule: higher total, then higher rebuttal, then higher evidence; a full tie leaves the judge's call", () => {
  assert.equal(ruleWinner({ A: sc(5, 5, 5, 5), B: sc(6, 5, 5, 5) }), "B");
  assert.equal(ruleWinner({ A: sc(7, 5, 6, 6), B: sc(6, 6, 5, 7) }), "A"); // equal totals (24): A's rebuttal 6 > 5
  assert.equal(ruleWinner({ A: sc(7, 6, 5, 6), B: sc(6, 7, 5, 6) }), "A"); // totals equal, rebuttal equal, A's evidence higher
  assert.equal(ruleWinner({ A: sc(6, 6, 6, 6), B: sc(6, 6, 6, 6) }), undefined);
  assert.equal(parse({ winner: "B", scores: { A: sc(7, 5, 6, 6), B: sc(6, 6, 5, 7) } }).ok, false);
  assert.ok(parse({ winner: "B", scores: { A: sc(6, 6, 6, 6), B: sc(6, 6, 6, 6) } }).ok);
  assert.match(JUDGE_SYSTEM, /WINNER RULE: the winner is the agent with the higher TOTAL/);
});

test("references are validated against the transcript: unknown ids, wrong speaker and fabricated quotes are dropped", () => {
  const r = parse(refs(
    { ref: "E3", side: "A", note: "separates timing from intent", quote: "timing is not intent" }, // punctuation/case-insensitive match
    { ref: "E9", side: "A", note: "does not exist" },
    { ref: "E2", side: "A", note: "wrong speaker" },
    { ref: "E4", side: "B", note: "invented quote", quote: "the guard confessed" },
    { ref: "e1", side: "A", note: "lower-case id is fine" },
  ));
  assert.ok(r.ok);
  assert.deepEqual(r.verdict.references!.map((x) => x.ref), ["E3", "E1"]);
  assert.deepEqual(r.verdict.validation!.rejectedReferences.map((x) => x.ref), ["E9", "E2", "E4"]);
  assert.match(r.verdict.validation!.rejectedReferences[2].reason, /quote does not appear/);
  const none = parse(refs({ ref: "E9", side: "A", note: "x" }, { ref: "E4", side: "B", note: "y", quote: "made up" }));
  assert.ok(!none.ok && /no valid transcript reference/.test(none.reason));
});

test("both agents' unsupported assumptions, strengths and weaknesses are kept symmetrically; unknown refs inside them are dropped", () => {
  const r = parse({
    unsupportedAssumptions: [{ side: "A", ref: "E1", assumption: "a thief always avoids attention" }, { side: "B", ref: "E99", assumption: "an alarm is deliberately triggered" }],
    decisiveExchange: { refs: ["E3", "E42"], description: "timing versus intent" },
  });
  assert.ok(r.ok);
  assert.deepEqual(r.verdict.unsupportedAssumptions!.map((a) => [a.side, a.ref]), [["A", "E1"], ["B", undefined]]);
  assert.deepEqual(r.verdict.decisiveExchange!.refs, ["E3"]);
  for (const side of ["A", "B"] as const) assert.ok(r.verdict.strengths![side].length >= 1 && r.verdict.weaknesses![side].length >= 1);
  assert.equal(parse({ strengths: { A: ["only one side"], B: [] } }).ok, false); // each side needs a strength and a weakness
  assert.match(JUDGE_SYSTEM, /SAME scrutiny to both agents/);
  assert.match(JUDGE_SYSTEM, /weigh the strengths and weaknesses of BOTH/);
});

test("rubric: honest uncertainty is not punished, a hypothesis is not evidence, rebuttal is not general persuasion, repetition is not rebuttal", () => {
  for (const re of [
    /Honest acknowledgement of uncertainty is not a flaw/,
    /hypothetical explanation is not established evidence/,
    /REBUTTAL: how effectively the agent answers its opponent's STRONGEST points/,
    /merely repeating the same criticism is not a rebuttal/,
    /Confidence is not evidence/,
    /0-2 = fails.*9-10 = exceptional/,
  ])
    assert.match(JUDGE_SYSTEM, re);
  // the judge can score rebuttal and persuasion apart: B persuasive (9) but weak rebuttal (3), A the reverse
  const r = parse({ winner: "A", scores: { A: sc(6, 6, 8, 5), B: sc(6, 6, 3, 9) } });
  assert.ok(r.ok && r.verdict.scores.A.rebuttal > r.verdict.scores.B.rebuttal && r.verdict.scores.B.persuasion > r.verdict.scores.A.persuasion);
});

test("malformed or incomplete judge outputs fail safely: no winner is invented", async () => {
  for (const bad of ["Both were great", '{"winner":"A"', JSON.stringify({ winner: "tie" }), verdictJson({ winner: "C" }), verdictJson({ decisiveExchange: undefined }), verdictJson({ references: "none" }), '{"winner":"A","explanation":"x","scores":{"A":{},"B":{}}}'])
    assert.equal(parseVerdict(bad, entries).ok, false, bad.slice(0, 40));
  const m = mockGenerate(() => verdictJson({ references: [{ ref: "E99", side: "A", note: "x" }] }));
  const r = await createDebateEngine({ ...config, judgeParseRetries: 0 }, { generate: m.fn }).judgeDebate({ roundId: "r", scenario, transcript });
  assert.ok(!r.ok && r.error.kind === "invalid_output");
  assert.equal(m.calls.length, 1);
});

test("a valid verdict through the engine carries scores, overall, summary, strengths, references and the decisive exchange in one request", async () => {
  const m = mockGenerate(() => verdictJson({ references: [{ ref: "E3", side: "A", note: "timing is not intent", quote: "timing is not intent" }], decisiveExchange: { refs: ["E3", "E4"], description: "intent versus open logbook" } }));
  const r = await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r", scenario, transcript });
  assert.ok(r.ok);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].cfg.model, "mock-judge");
  assert.deepEqual(r.verdict.decisiveExchange!.refs, ["E3", "E4"]);
  assert.ok(r.verdict.summary && r.verdict.overall && r.verdict.strengths && r.verdict.weaknesses);
});

test("judge instructions separate missing evidence from contradictory evidence, symmetrically, without more output or requests", async () => {
  for (const re of [
    /ABSENCE vs CONTRADICTION/,
    /CONTRADICTS a claim only if it positively rules it out/,
    /does not mention \(for example, no insurance claim is described\) weakens an assertion that it has ALREADY happened, but does not disprove a theory that it will or might happen/,
    /an alarm sounding proves neither an opportunistic thief nor a staged theft\) supports neither, so each agent must justify its own reading/,
    /Do not reward an agent merely for noting that information is missing/,
    /reward it for showing that its opponent's inference does not follow from the available facts/,
    /unsupported assumption and a contradicted fact are different things/,
    /analyse every plausible alternative interpretation instead of dismissing it/,
    /score both agents by this same test/,
  ])
    assert.match(JUDGE_SYSTEM, re);
  assert.match(JUDGE_SYSTEM, /Decide who DEBATED better, not which interpretation is objectively true/);
  // the verdict contract is unchanged: same fields, one request, validated references
  const m = mockGenerate(() => verdictJson());
  const r = await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r", scenario, transcript });
  assert.ok(r.ok && m.calls.length === 1);
  assert.ok(JUDGE_SYSTEM.length < 9_000); // the rubric stays compact (about 1.5K tokens)
});

test("a verdict may credit an agent for showing an inference does not follow, and record both sides' unsupported assumptions, without treating absence as contradiction", () => {
  const r = parse({
    winner: "B",
    scores: { A: sc(5, 4, 5, 7), B: sc(7, 7, 8, 6) },
    explanation: "B showed that A's alarm premise does not follow from the facts, and kept its own staged-theft theory as a possibility.",
    strengths: { A: ["Clear, direct case"], B: ["Showed the alarm premise does not follow"] },
    weaknesses: { A: ["Treated the alarm as proof of an opportunist"], B: ["No claim is described, so fraud stays unproven"] },
    unsupportedAssumptions: [{ side: "A", ref: "E1", assumption: "an alarm means the thief was not planning" }, { side: "B", ref: "E2", assumption: "a future claim is intended" }],
    references: [{ ref: "E1", side: "A", note: "assumes alarm implies no plan" }, { ref: "E2", side: "B", note: "alarm can create an official timeline" }],
  });
  assert.ok(r.ok);
  assert.deepEqual(r.verdict.unsupportedAssumptions!.map((a) => a.side), ["A", "B"]);
  assert.equal(r.verdict.winner, "B");
});

test("final calibration: the judge prompt separates missing from contradictory evidence, later from earlier events, assumption from disproof, and applies one standard to both agents", async () => {
  for (const re of [
    // missing information vs contradiction
    /CONTRADICTS a claim only if it positively rules it out/,
    // future events vs events that should already have happened
    /weakens an assertion that it has ALREADY happened, but does not disprove a theory that it will or might happen/,
    /absence of something that would reasonably happen LATER \(a claim not yet filed, a confession not yet made\) is no evidence that an earlier plan did not exist/,
    /demanding evidence the scenario could not yet contain earns no credit/,
    // unsupported assumptions vs disproven claims
    /a theory still needs support of its own, so an unsupported inference stays weaker than a supported one without being contradicted/,
    /Keep four things apart: observations, reasonable inferences, unsupported assumptions, and facts that directly contradict a claim/,
    /An unsupported assumption and a contradicted fact are different things/,
    // evidence compatible with both interpretations
    /an alarm sounding proves neither an opportunistic thief nor a staged theft\) supports neither/,
    /"an alarm sounded" does not show a thief panicked and "no forced entry" does not show the theft was opportunistic rather than staged/,
    // symmetry and what earns credit
    /score both agents by this same test/,
    /reward it for showing that its opponent's inference does not follow from the available facts, for exposing a real logical inconsistency or an unsupported causal link, and for citing genuinely contradictory evidence/,
    /Do not prejudge which interpretation is correct; use only the case evidence and the public transcript/,
  ])
    assert.match(JUDGE_SYSTEM, re);
  // the standard is theory-neutral: no scoring bonus or penalty tied to either interpretation or to any named claim
  assert.doesNotMatch(JUDGE_SYSTEM, /Agent A (gets|receives|should)|Agent B (gets|receives|should)|bonus|penalty of \d|\+\d|-\d points/i);
  assert.doesNotMatch(JUDGE_SYSTEM, /\bbets?\b|balance|injection|player|supporters/i); // no betting or private-audience vocabulary
  assert.ok(JUDGE_SYSTEM.length < 10_000, `judge system prompt is ${JUDGE_SYSTEM.length} characters`);
});

test("final calibration: the judge contract is unchanged: one request, four 0-10 dimensions, same schema, winner rule and reference validation", async () => {
  const m = mockGenerate(() => verdictJson());
  const r = await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r", scenario, transcript });
  assert.ok(r.ok && m.calls.length === 1);
  assert.deepEqual(Object.keys(r.verdict.scores.A).sort(), ["evidence", "logic", "persuasion", "rebuttal"]);
  assert.match(JUDGE_SYSTEM, /"evidence":0-10,"logic":0-10,"rebuttal":0-10,"persuasion":0-10/);
  assert.match(JUDGE_SYSTEM, /WINNER RULE: the winner is the agent with the higher TOTAL/);
  // mocked outputs still validate; scoring is not nudged by theory: either side can win on equal footing
  for (const winner of ["A", "B"] as const) {
    const loser = winner === "A" ? "B" : "A";
    const ok = parse({ winner, scores: { [winner]: sc(7, 7, 7, 6), [loser]: sc(6, 6, 6, 6) } });
    assert.ok(ok.ok && ok.verdict.winner === winner);
  }
  assert.equal(parse({ winner: "A", scores: { A: sc(5, 5, 5, 5), B: sc(7, 7, 7, 7) } }).ok, false); // a winner contradicting the scores still fails safely
  assert.equal(parse({ references: [{ ref: "E99", side: "A", note: "x" }] }).ok, false); // fabricated references still rejected
});

test("final calibration: the judge sees only the case and the public transcript; no private audience or betting data", async () => {
  const m = mockGenerate(() => verdictJson());
  const leaky = transcript.map((e) => ({ ...e, injections: ["SECRET-AUDIENCE"], supporters: 99, groups: ["SECRET-GROUP"], bets: { A: 500 } }));
  await createDebateEngine(config, { generate: m.fn }).judgeDebate({ roundId: "r", scenario, transcript: leaky });
  assert.doesNotMatch(m.calls[0].req.prompt, /SECRET|supporters|\b500\b|bets/);
  assert.equal(m.calls.length, 1);
});
