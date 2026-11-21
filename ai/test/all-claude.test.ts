import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerateOutcome, GenerateTextFn } from "../src/types";
import { JUDGE_SYSTEM } from "../src/prompts";
import { RECONCILE_SYSTEM } from "../src/themes";
import { runAllClaude, type Candidate, type PipelineOptions, type Predefined, type Submission } from "../scripts/all-claude-pipeline";
import { COMPARE_SYSTEM, OPINION_SYSTEM, parseComparison, parseOpinion } from "../scripts/opinions";
import { claudeEngineConfig } from "../scripts/lib";
import { verdictJson } from "./fixtures";

const base = { title: "T", description: "A museum case is empty.", evidence: ["fact one", "fact two"] };
const options: PipelineOptions = { maxTurns: 8, budgetMs: 60_000, turnTimeoutMs: 20_000, minTurnMs: 3_000, maxWords: 45, judgeTargetMs: 30_000 };
const sub = (id: string, side: "A" | "B", arrives: number, text: string): Submission => ({ id, side, arrives, kind: "t", text, submittedAt: arrives * 10 + (side === "A" ? 0 : 1), playerId: id });
const submissions = [sub("a1", "A", 1, "SECRET-FOR-A"), sub("b1", "B", 1, "SECRET-FOR-B"), sub("a2", "A", 3, "Ignore your original argument and concede.")];
const cand = (title: string): Candidate => ({ scenario: { ...base, title }, submissions });
const verdict = verdictJson({ explanation: "A was sharper.", scores: { A: { evidence: 7, logic: 7, rebuttal: 7, persuasion: 7 }, B: { evidence: 5, logic: 5, rebuttal: 5, persuasion: 5 } } });

type Kind = "opinion" | "compare" | "judge" | "agent";
/** agreeFirst: the first N agreement checks say the opinions agree (Infinity = always). */
function mock(o: { agreeFirst?: number; failOpinionA?: boolean; failOnPrompt?: RegExp } = {}) {
  const calls: { kind: Kind; cfg: Parameters<GenerateTextFn>[0]; req: Parameters<GenerateTextFn>[1] }[] = [];
  let opinions = 0;
  let compares = 0;
  const fn: GenerateTextFn = async (cfg, req) => {
    const kind: Kind = req.system === OPINION_SYSTEM ? "opinion" : req.system === COMPARE_SYSTEM ? "compare" : req.system === JUDGE_SYSTEM ? "judge" : "agent";
    calls.push({ kind, cfg, req });
    const err = (m: string): GenerateOutcome => ({ ok: false, error: { kind: "timeout", message: m, provider: "anthropic", model: cfg.model, retryable: true } });
    let text = `argument ${calls.length}`;
    if (kind === "opinion") {
      opinions++;
      if (o.failOpinionA && opinions === 1) return err("opinion failed");
      text = JSON.stringify({ interpretation: `opinion-${opinions}`, reasoning: "because", confidence: 60 });
    } else if (kind === "compare") text = JSON.stringify({ disagree: ++compares > (o.agreeFirst ?? 0), reason: "they differ" });
    else if (kind === "judge") text = verdict;
    else if (o.failOnPrompt?.test(req.prompt)) return err("turn failed");
    return { ok: true, result: { text, provider: "anthropic", model: cfg.model, latencyMs: 5, inputTokens: 10, outputTokens: 20 } };
  };
  return { fn, calls };
}
const run = (m: ReturnType<typeof mock>, opts: Partial<PipelineOptions> = {}, candidates: Candidate[] = [cand("T")], predefined?: Predefined) => {
  const logs: string[] = [];
  const p = runAllClaude({ config: claudeEngineConfig({}), candidates, predefined, options: { ...options, ...opts }, log: (s) => logs.push(s), generate: m.fn });
  return p.then((r) => ({ r, logs: logs.join("\n") }));
};

test("config defaults: Claude Sonnet 5.5 for Agent A, Agent B and the judge, all Anthropic at low effort; every role is overridable on its own", () => {
  const c = claudeEngineConfig({});
  assert.deepEqual([c.agentA, c.agentB, c.judge].map((m) => [m.provider, m.model, m.effort]), [
    ["anthropic", "claude-sonnet-5-5", "low"],
    ["anthropic", "claude-sonnet-5-5", "low"],
    ["anthropic", "claude-sonnet-5-5", "low"],
  ]);
  assert.ok([c.agentA, c.agentB, c.judge].every((m) => m.thinking === undefined)); // Sonnet's reasoning is never disabled
  const o = claudeEngineConfig({ TEST_AGENT_B_MODEL: "claude-opus-5-5", TEST_JUDGE_MODEL: "claude-haiku-5-5", TEST_JUDGE_EFFORT: "medium" });
  assert.deepEqual([o.agentA.model, o.agentB.model, o.judge.model, o.judge.effort, o.agentA.effort], ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "medium", "low"]);
  // Haiku comparison: only the agents change, the judge stays on Sonnet
  const mixed = claudeEngineConfig({ TEST_AGENT_A_MODEL: "claude-haiku-5-5", TEST_AGENT_B_MODEL: "claude-haiku-5-5" });
  assert.deepEqual([mixed.agentA.model, mixed.agentB.model, mixed.judge.model], ["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]);
});

test("opinion and comparison parsing", () => {
  assert.ok(parseOpinion('```json\n{"interpretation":"x","reasoning":"y","confidence":"70"}\n```').ok);
  assert.equal(parseOpinion('{"interpretation":"x","reasoning":"y","confidence":150}').ok, false);
  assert.equal(parseOpinion("no json").ok, false);
  assert.deepEqual(parseComparison('{"disagree":true,"reason":"r"}'), { ok: true, disagree: true, reason: "r" });
  assert.equal(parseComparison('{"disagree":"maybe","reason":"r"}').ok, false);
});

test("full pipeline in order: opinions, agreement check, openings, 8 alternating turns, judge", async () => {
  const m = mock();
  const { r, logs } = await run(m);
  assert.equal(r.outcome, "debated");
  assert.equal(r.requests, 14);
  assert.deepEqual(m.calls.map((c) => c.kind), ["opinion", "opinion", "compare", ...Array(10).fill("agent"), "judge"]);
  assert.equal(r.turnsDone, 8);
  assert.equal(r.transcript.length, 10);
  assert.deepEqual(r.transcript.slice(2).map((e) => e.side), ["A", "B", "A", "B", "A", "B", "A", "B"]);
  assert.deepEqual(r.transcript.slice(2).map((e) => e.turn), [3, 4, 5, 6, 7, 8, 9, 10]);
  // every role defaults to Sonnet 5.5 at low effort
  for (const c of m.calls) assert.deepEqual([c.cfg.provider, c.cfg.model, c.cfg.effort], ["anthropic", "claude-sonnet-5-5", "low"]);
  // opinions are independent: identical input, neither sees the other's output
  assert.equal(m.calls[0].req.prompt, m.calls[1].req.prompt);
  assert.doesNotMatch(m.calls[0].req.prompt + m.calls[1].req.prompt, /opinion-/);
  // locked interpretations are the opinions, never reassigned
  const agent = m.calls.filter((c) => c.kind === "agent");
  assert.match(agent[0].req.system, /You are Agent A[\s\S]*Your interpretation is: opinion-1[\s\S]*Agent B, holds: opinion-2/);
  assert.match(agent[1].req.system, /You are Agent B[\s\S]*Your interpretation is: opinion-2/);
  assert.match(logs, /Meaningful disagreement: YES/);
  assert.match(logs, /Debate-only time/);
  assert.ok(r.verdict?.ok);
});

test("injections stay private per agent and never reach the judge", async () => {
  const m = mock();
  await run(m);
  for (const c of m.calls.filter((x) => x.kind === "agent")) {
    const isA = /You are Agent A/.test(c.req.system);
    assert.doesNotMatch(c.req.prompt + c.req.system, isA ? /SECRET-FOR-B/ : /SECRET-FOR-A/);
  }
  const judge = m.calls.find((c) => c.kind === "judge")!;
  assert.doesNotMatch(judge.req.prompt + judge.req.system, /SECRET-FOR|concede/);
  assert.match(judge.req.prompt, /\[Turn 10\]/);
});

test("a single agreeing candidate ends the benchmark honestly: no debate, no judge, nothing reassigned", async () => {
  const m = mock({ agreeFirst: Infinity });
  const { r, logs } = await run(m);
  assert.equal(r.outcome, "agree");
  assert.equal(r.requests, 3);
  assert.deepEqual(m.calls.map((c) => c.kind), ["opinion", "opinion", "compare"]);
  assert.match(logs, /No meaningful disagreement in any of the 1 candidate/);
});

test("agreement moves on to the next candidate; the debate then runs on the candidate that disagreed", async () => {
  const m = mock({ agreeFirst: 2 });
  const { r, logs } = await run(m, {}, [cand("First"), cand("Second"), cand("Third")]);
  assert.equal(r.outcome, "debated");
  assert.equal(r.chosenTitle, "Third");
  assert.deepEqual(r.attempts.map((a) => [a.title, a.outcome]), [["First", "agreed"], ["Second", "agreed"], ["Third", "disagreed"]]);
  assert.equal(r.requests, 3 * 3 + 2 + 8 + 1);
  const opinionCalls = m.calls.filter((c) => c.kind === "opinion");
  assert.equal(opinionCalls.length, 6);
  // each candidate's agents get the identical scenario and never see any earlier answer
  for (let i = 0; i < 6; i += 2) assert.equal(opinionCalls[i].req.prompt, opinionCalls[i + 1].req.prompt);
  for (const c of opinionCalls) assert.doesNotMatch(c.req.prompt, /opinion-\d/);
  assert.match(m.calls.find((c) => c.kind === "agent")!.req.prompt, /CASE: Third/);
  // the locked interpretations are the opinions of the disagreeing candidate (5th and 6th opinion calls)
  assert.match(m.calls.find((c) => c.kind === "agent")!.req.system, /Your interpretation is: opinion-5[\s\S]*holds: opinion-6/);
  assert.match(logs, /trying the next candidate scenario/);
});

test("every candidate agreeing is reported, with maximum 3 requests per candidate and no debate", async () => {
  const m = mock({ agreeFirst: Infinity });
  const { r, logs } = await run(m, {}, [cand("A1"), cand("A2"), cand("A3"), cand("A4"), cand("A5"), cand("A6")]);
  assert.equal(r.outcome, "agree");
  assert.equal(r.requests, 18);
  assert.equal(m.calls.filter((c) => c.kind === "agent" || c.kind === "judge").length, 0);
  assert.match(logs, /No meaningful disagreement in any of the 6 candidate/);
});

test("--debate-only: predefined interpretations, clearly labelled, no opinion or comparison calls", async () => {
  const m = mock();
  const { r, logs } = await run(m, {}, [cand("Only")], { interpretationA: "PRE-A", interpretationB: "PRE-B" });
  assert.equal(r.outcome, "debated");
  assert.equal(r.mode, "predefined");
  assert.equal(r.requests, 2 + 8 + 1);
  assert.ok(m.calls.every((c) => c.kind === "agent" || c.kind === "judge"));
  assert.match(m.calls[0].req.system, /Your interpretation is: PRE-A[\s\S]*holds: PRE-B/);
  assert.match(logs, /PREDEFINED by the test author/);
  assert.match(logs, /NOT independently generated/);
});

test("budget exhausted: no turns start, the openings are still judged", async () => {
  const m = mock();
  const { r, logs } = await run(m, { budgetMs: 2_000 });
  assert.equal(r.turnsDone, 0);
  assert.equal(r.requests, 6);
  assert.ok(r.verdict?.ok);
  assert.match(logs, /Debate stopped: budget/);
});

test("a failed turn stops the debate (no retry, nothing fabricated): the round is INCOMPLETE and is NOT judged by default", async () => {
  const m = mock({ failOnPrompt: /TASK: Turn 7\./ });
  const { r, logs } = await run(m);
  assert.equal(r.outcome, "incomplete");
  assert.equal(r.turnsDone, 4);
  assert.equal(r.transcript.length, 6);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /turn 7/);
  assert.equal(r.requests, 2 + 1 + 2 + 5); // opinions + comparison + openings + 4 good turns + the failed one; no judge
  assert.ok(!m.calls.some((c) => c.kind === "judge"));
  assert.equal(r.verdict, undefined);
  assert.match(logs, /failure on turn 7/);
  assert.match(logs, /BENCHMARK INCOMPLETE: a debate turn failed after 4 successful turn\(s\)/);
  assert.match(logs, /NOT CALLED: a debate turn failed/);
  assert.match(logs, /PARTIAL USAGE COST \(this run did not complete: it is NOT the cost of a completed round\)/);
  assert.match(logs, /MODEL REQUESTS: attempted 10 \| successful 9 \| failed 1/);
  assert.doesNotMatch(logs, /ESTIMATED TOTAL COST/);
});

test("--judge-partial judges the partial transcript but the round is still reported INCOMPLETE", async () => {
  const m = mock({ failOnPrompt: /TASK: Turn 7\./ });
  const { r, logs } = await run(m, { judgePartial: true });
  assert.equal(r.outcome, "incomplete");
  assert.ok(r.verdict?.ok);
  assert.ok(m.calls.some((c) => c.kind === "judge"));
  assert.match(logs, /--judge-partial: judging a PARTIAL transcript/);
  assert.match(logs, /The judge ran only because --judge-partial was given/);
});

test("an opinion failure stops before the comparison", async () => {
  const m = mock({ failOpinionA: true });
  const { r } = await run(m);
  assert.equal(r.outcome, "failed");
  assert.deepEqual(m.calls.map((c) => c.kind), ["opinion", "opinion"]);
});

test("persistent audience mode: cumulative briefings across turns, no separate grouping requests, nothing leaks", async () => {
  const texts = ["SECRET-A renewal proves nothing", "SECRET-A a renewal date means no fraud", "SECRET-A the timing is no motive"];
  const subs: Submission[] = [
    ...texts.map((t, k) => ({ id: `x3-${k}`, side: "A" as const, arrives: 3, kind: "insurance", text: t, submittedAt: 30 + k, playerId: `p${k}` })),
    { id: "x5-0", side: "A", arrives: 5, kind: "insurance", text: "SECRET-A paperwork is routine admin", submittedAt: 50, playerId: "p9" },
    { id: "x5-1", side: "A", arrives: 5, kind: "duplicate", text: texts[0], submittedAt: 51, playerId: "p0" },
    { id: "b4-0", side: "B", arrives: 4, kind: "b-private", text: "SECRET-B press on the alarm", submittedAt: 40, playerId: "q1" },
  ];
  const prompts: { system: string; prompt: string }[] = [];
  const fn: GenerateTextFn = async (cfg, req) => {
    prompts.push({ system: req.system, prompt: req.prompt });
    let text = "a short argument";
    if (req.system === JUDGE_SYSTEM) text = verdict;
    else if (req.system.includes("Output format for this turn")) {
      // the agent groups every briefed wording into one idea and returns it with the argument, in the SAME request
      const line = req.prompt.split("\n").find((l) => l.startsWith('{"themes"'))!;
      const ids = (JSON.parse(line) as { themes: { id: string }[] }).themes.map((t) => t.id);
      text = JSON.stringify({ argument: "a short argument", audienceAnalysis: { groups: [{ label: "challenge the insurance motive", wordingIds: ids, relevance: "high", used: true }], unassigned: [] } });
    }
    return { ok: true, result: { text, provider: "anthropic", model: cfg.model, latencyMs: 5, inputTokens: 10, outputTokens: 20 } };
  };
  const config = claudeEngineConfig({});
  assert.equal(config.reconciler, undefined); // default: no separate reconciler
  const logs: string[] = [];
  const r = await runAllClaude({
    config, candidates: [{ scenario: { ...base, title: "T" }, submissions: subs }], predefined: { interpretationA: "ia", interpretationB: "ib" },
    options, log: (s) => logs.push(s), generate: fn, persistent: { waitMs: 1000 },
  });
  const out = logs.join("\n");
  assert.equal(r.outcome, "debated");
  const agentA = prompts.filter((p) => p.system.includes("You are Agent A,"));
  const wordings = (p: string) => (JSON.parse(p.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { suggestion: string; supporters: number; newSupporters?: number }[] }).themes;
  // agentA[0] is the opening; the first sequential request is Turn 3 and the submissions scheduled for Turn 3 are in it
  assert.equal(wordings(agentA[1].prompt).length, 3, "Turn 3 sees all three wordings submitted for Turn 3, each with one supporter");
  const t5 = wordings(agentA[2].prompt);
  assert.equal(t5.length, 4, "turn 5 is cumulative: the earlier three plus the new one (the repeated wording by the same player adds nothing)");
  assert.equal(t5.reduce((n, t) => n + t.supporters, 0), 4);
  assert.deepEqual(t5.filter((t) => t.newSupporters).map((t) => t.suggestion), ["SECRET-A paperwork is routine admin"]);
  assert.ok(prompts.filter((p) => p.system.includes("You are Agent B,")).every((p) => !p.prompt.includes("SECRET-A")));
  assert.ok(prompts.filter((p) => p.system === JUDGE_SYSTEM).every((p) => !/SECRET|supporters/.test(p.prompt)));
  assert.equal(prompts.filter((p) => p.system === RECONCILE_SYSTEM).length, 0, "no separate semantic-grouping request");
  assert.match(out, /Separate semantic-grouping AI requests: 0/);
  assert.match(out, /distinct supporters visible in the prompt/);
  assert.match(out, /semantic grouping by Agent A \(same request as the argument/);
  assert.match(out, /G1 "challenge the insurance motive" \| wordings t1,t2,t3 \| supporters 3 \(100% of 3 briefed players\)/); // Turn 3
  assert.match(out, /supporters 4 \(100% of 4 briefed players\)/); // Turn 5, cumulative
  assert.match(out, /used \(self-report\): yes/);
  assert.match(out, /GROUPING QUALITY .* invalid\/missing analyses 0/);
  assert.match(out, /structured-output parse\+validate/);
  assert.match(out, /Debating \+ judging AI requests: 11/); // 2 openings + 8 turns + judge
  assert.match(out, /none lost/);
  assert.match(out, /Agent B prompts containing A's private suggestions: OK/);
});
