import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { createThemeCoordinator } from "../src/coordinator";
import { interpretAnthropicResponse } from "../src/providers";
import { parseTurnOutput, validateAudienceAnalysis } from "../src/grouping";
import { buildThemeBriefing, createAudienceThemeState, ingestSubmissions } from "../src/themes";
import { countWords } from "../src/wordlimit";
import { runAllClaude, type PipelineOptions } from "../scripts/all-claude-pipeline";
import { claudeEngineConfig, defaultMaxOutputTokens } from "../scripts/lib";
import { CONTRADICTORY_KINDS, generateParticipants, NOISE_KINDS, REAL_KINDS } from "../scripts/participants-200";
import { estimateCost } from "../scripts/pricing";
import type { AudienceInjection, EngineConfig, GenerateOutcome, GenerateTextFn, ModelConfig, Side } from "../src/types";
import { config as baseConfig, mockGenerate, scenario } from "./fixtures";

const cfg: ModelConfig = { provider: "anthropic", model: "claude-haiku-5-5", maxOutputTokens: 1400, timeoutMs: 1000, maxRetries: 0 };
const config: EngineConfig = { ...baseConfig, injections: { maxPerAgent: 3, maxChars: 200 } };
const mk = (id: string, side: Side, text: string, t: number, playerId: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });
const idsIn = (prompt: string) => (JSON.parse(prompt.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { id: string }[] }).themes.map((t) => t.id);
const truncated = (partialText: string): GenerateOutcome => ({ ok: false, error: { kind: "truncated", message: "Output hit maxOutputTokens (1400)", provider: "anthropic", model: "claude-haiku-5-5", retryable: false, latencyMs: 900, inputTokens: 2100, outputTokens: 1400, partialText } });

test("provider mapping: a reply cut at max_tokens stays a failure but keeps the reported usage and the visible text", () => {
  const cut = interpretAnthropicResponse({ content: [{ type: "thinking" }, { type: "text", text: '{"argument":"Cut.' }], stop_reason: "max_tokens", model: "claude-haiku-5-5", usage: { input_tokens: 2100, output_tokens: 1400 } }, cfg, 900);
  assert.ok(!cut.ok);
  assert.deepEqual([cut.error.kind, cut.error.inputTokens, cut.error.outputTokens, cut.error.partialText], ["truncated", 2100, 1400, '{"argument":"Cut.']);
  assert.match(cut.error.message, /1400 output tokens used.*thinking tokens count toward the cap/);
  const onlyThinking = interpretAnthropicResponse({ content: [{ type: "thinking" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 1400 } }, cfg, 1);
  assert.ok(!onlyThinking.ok && onlyThinking.error.kind === "truncated" && !onlyThinking.error.partialText); // the budget went to thinking
  const ok = interpretAnthropicResponse({ content: [{ type: "text", text: " hello " }], stop_reason: "end_turn", model: "claude-haiku-5-5", usage: { input_tokens: 5, output_tokens: 7 } }, cfg, 3);
  assert.ok(ok.ok && ok.result.text === "hello" && ok.result.outputTokens === 7);
  const refused = interpretAnthropicResponse({ content: [], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 1 } }, cfg, 3);
  assert.ok(!refused.ok && refused.error.kind === "refusal" && refused.error.inputTokens === 5);
  assert.ok(!interpretAnthropicResponse({ content: [{ type: "text", text: "" }], stop_reason: "end_turn" }, cfg, 3).ok);
});

test("compact grouping: 100 distinct wordings fit in a small visible reply, with ids only, and TypeScript computes the counts", () => {
  const subs = Array.from({ length: 100 }, (_, k) => mk(`s${k}`, "A", `Distinct audience wording number ${k} about the case`, k, `p${k}`));
  const state = ingestSubmissions(createAudienceThemeState("r", "A"), subs, 200).state;
  const briefing = buildThemeBriefing(state);
  const ids = state.themes.map((t) => t.id);
  assert.equal(briefing.themes.length, 100);
  const slice = (a: number, b: number) => ids.slice(a, b).join(" ");
  const reply = JSON.stringify({
    argument: "Forty words of public argument, one coherent rebuttal to the opponent.",
    audienceAnalysis: {
      groups: [
        { label: "Challenge insurance motive", wordingIds: slice(0, 30), relevance: "high", used: true },
        { label: "Alarm proves nothing", wordingIds: slice(30, 50), relevance: "high", used: true },
        { label: "Keys point to access", wordingIds: slice(50, 60), relevance: "medium", used: false },
        { label: "Logbook unreadable", wordingIds: slice(60, 72), relevance: "medium", used: false },
        { label: "Fifteen minute gap", wordingIds: slice(72, 75), relevance: "high", used: false },
        { label: "Staged claim", wordingIds: slice(75, 79), relevance: "low", used: false },
      ],
      unassigned: { irrelevant: slice(79, 84), fabricated: slice(84, 90), adversarial: slice(90, 94), unclear: slice(94, 100) },
    },
  });
  assert.ok(reply.length < 1_700, `compact reply is ${reply.length} characters (about ${Math.ceil(reply.length / 3)} tokens)`);
  const out = parseTurnOutput(reply);
  const a = validateAudienceAnalysis(out.analysis, out.problem, briefing, state, 0);
  assert.equal(a.valid, true);
  assert.deepEqual(a.rejected, []);
  assert.deepEqual(a.groups.map((g) => g.supporters), [30, 20, 10, 12, 3, 4]); // computed from player ids
  assert.equal(a.unassigned.length, 21);
  assert.deepEqual(a.unmentionedWordingIds, []);
  assert.equal(a.totals.groupedPlayers + a.unassigned.length, 100); // full accounting of all 100 wordings
  // the older verbose list forms are still accepted and give the same result
  const verbose = { groups: a.groups.map((g) => ({ label: g.label, wordingIds: g.sourceWordingIds, relevance: g.relevance, used: g.usedInArgument })), unassigned: a.unassigned.map((u) => ({ wordingId: u.wordingId, reason: u.reason })) };
  assert.ok(JSON.stringify(verbose).length > JSON.stringify(JSON.parse(reply).audienceAnalysis).length);
  assert.deepEqual(validateAudienceAnalysis(verbose, undefined, briefing, state, 0).groups.map((g) => g.supporters), [30, 20, 10, 12, 3, 4]);
});

test("complete, truncated and unreadable structured replies", () => {
  const complete = JSON.stringify({ argument: "Whole argument here.", audienceAnalysis: { groups: [], unassigned: {} } });
  assert.equal(parseTurnOutput(complete).argument, "Whole argument here.");
  const afterArgument = '{"argument":"Whole argument here.","audienceAnalysis":{"groups":[{"label":"Cha';
  assert.equal(parseTurnOutput(afterArgument).argument, "Whole argument here."); // the argument string is closed: readable
  assert.match(parseTurnOutput(afterArgument).problem!, /salvaged/);
  assert.equal(parseTurnOutput('{"argument":"Half an argu').argument, ""); // an unclosed argument is never kept
  assert.equal(parseTurnOutput("").argument, "");
});

test("engine: a truncated structured reply keeps its complete argument; grouping is reported invalid; no extra request; usage is kept", async () => {
  const partial = '{"argument":"The renewal proves timing, not intent, and the alarm fits an opportunist.","audienceAnalysis":{"groups":[{"label":"Insurance","wordingIds":"t1 t2 t';
  const calls: string[] = [];
  const fn: GenerateTextFn = async (c) => {
    calls.push(c.model);
    return truncated(partial);
  };
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: fn }), { roundId: "r", scenario });
  coord.submit([mk("a", "A", "challenge the insurance motive", 1, "p1"), mk("b", "A", "alarm proves nothing", 2, "p2")]);
  const t = await coord.nextTurn({ speaker: "A" });
  assert.ok(t.result.ok);
  assert.equal(t.result.argument.text, "The renewal proves timing, not intent, and the alarm fits an opportunist.");
  assert.equal(t.result.argument.meta.truncated, true);
  assert.deepEqual([t.result.argument.meta.inputTokens, t.result.argument.meta.outputTokens], [2100, 1400]);
  assert.equal(t.result.audienceAnalysis!.valid, false);
  assert.ok(t.result.audienceAnalysis!.rejected.some((r) => /salvaged/.test(r.detail)));
  assert.equal(calls.length, 1); // never retried
  assert.equal(coord.audit("A").missing, 0);
  assert.deepEqual(coord.neverBriefed("A"), []); // the briefing WAS shown to the agent in the successful (salvaged) turn
});

test("engine: no complete argument, plain text cut mid-sentence, or a turn without briefing is never salvaged; the clear error keeps the usage", async () => {
  const run = async (partial: string, submit: boolean) => {
    const fn: GenerateTextFn = async () => truncated(partial);
    const coord = createThemeCoordinator(createDebateEngine(config, { generate: fn }), { roundId: "r", scenario });
    if (submit) coord.submit([mk("a", "A", "an idea", 1, "p1")]);
    return coord.nextTurn({ speaker: "A" });
  };
  const noArg = await run('{"argument":"Half an argu', true);
  assert.ok(!noArg.result.ok && noArg.result.error.kind === "truncated");
  assert.match(noArg.result.error.message, /no complete public argument could be recovered/);
  assert.deepEqual([noArg.result.error.inputTokens, noArg.result.error.outputTokens], [2100, 1400]);
  assert.ok(!(await run("The alarm sounded at 2 a.m. and the case was found", true)).result.ok); // plain text, cut mid-sentence
  assert.ok(!(await run('{"argument":"Complete."', false)).result.ok); // no briefing: not a structured turn
});

test("a failed turn does not mark the audience as represented (no false 'represented')", async () => {
  const fn: GenerateTextFn = async () => truncated("");
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: fn }), { roundId: "r", scenario });
  coord.submit([mk("a", "A", "an idea", 1, "p1"), mk("b", "A", "another idea", 2, "p2")]);
  const t = await coord.nextTurn({ speaker: "A" });
  assert.ok(!t.result.ok);
  assert.deepEqual(coord.neverBriefed("A").sort(), ["a", "b"]); // ingested, but represented in no successful turn
  assert.equal(coord.audit("A").missing, 0);
});

test("failed requests keep their reported tokens and are costed; attempted, successful and failed are separate", () => {
  const rep = estimateCost([
    { role: "agentA", model: "claude-haiku-5-5", ok: true, inputTokens: 1000, outputTokens: 100 },
    { role: "agentA", model: "claude-haiku-5-5", ok: false, inputTokens: 2100, outputTokens: 1400 },
    { role: "agentB", model: "claude-haiku-5-5", ok: false, inputTokens: 0, outputTokens: 0 },
  ]);
  assert.deepEqual([rep.byGroup.debaters.requests, rep.byGroup.debaters.failed], [3, 2]);
  assert.ok(Math.abs(rep.totalUsd - ((1000 * 0.1 + 100 * 0.5) + (2100 * 0.1 + 1400 * 0.5)) / 1e6) < 1e-12);
});

test("output caps are per model: Haiku 4096, other agents 2500, judge 2500; every one overridable; thinking can be disabled for Haiku", () => {
  assert.deepEqual([defaultMaxOutputTokens("claude-haiku-5-5", false), defaultMaxOutputTokens("claude-sonnet-5-5", false), defaultMaxOutputTokens("claude-haiku-5-5", true), defaultMaxOutputTokens("claude-sonnet-5-5", true)], [4096, 2500, 2500, 2500]);
  const d = claudeEngineConfig({});
  assert.deepEqual([d.agentA.maxOutputTokens, d.agentB.maxOutputTokens, d.judge.maxOutputTokens], [2500, 2500, 2500]); // Sonnet defaults
  assert.equal(d.agentA.thinking, undefined);
  const sonnet = claudeEngineConfig({ TEST_AGENT_A_MODEL: "claude-haiku-5-5", TEST_AGENT_B_MODEL: "claude-haiku-5-5" }); // Haiku comparison: larger cap
  assert.deepEqual([sonnet.agentA.maxOutputTokens, sonnet.agentB.maxOutputTokens, sonnet.judge.maxOutputTokens], [4096, 4096, 2500]);
  const o = claudeEngineConfig({ TEST_AGENT_MAX_TOKENS: "6000", TEST_JUDGE_MAX_TOKENS: "3000", TEST_AGENT_THINKING: "disabled" });
  assert.deepEqual([o.agentA.maxOutputTokens, o.judge.maxOutputTokens, o.agentA.thinking, o.agentB.thinking, o.judge.thinking], [6000, 3000, "disabled", "disabled", undefined]);
});

const options: PipelineOptions = { maxTurns: 8, budgetMs: 60_000, turnTimeoutMs: 20_000, minTurnMs: 3_000, maxWords: 45, judgeTargetMs: 30_000 };
const base = { title: "The Empty Display Case", description: "A museum case is empty.", evidence: ["The alarm sounded at 2 a.m.", "No sign of forced entry"] };

test("200-player run whose first sequential turn is truncated: INCOMPLETE, no judge, zero represented, partial cost labelled, 3 requests", async () => {
  const subs = generateParticipants();
  const calls: string[] = [];
  const fn: GenerateTextFn = async (c, req) => {
    calls.push(req.system.includes("Output format for this turn") ? "turn" : req.system.includes("independent judge") ? "judge" : "opening");
    if (req.system.includes("Output format for this turn")) return truncated(""); // thinking used the whole budget: nothing visible
    return { ok: true, result: { text: "A short opening argument. It has two sentences.", provider: "anthropic", model: c.model, latencyMs: 5, inputTokens: 800, outputTokens: 60 } };
  };
  const logs: string[] = [];
  const r = await runAllClaude({
    config: claudeEngineConfig({ TEST_AGENT_A_MODEL: "claude-haiku-5-5", TEST_AGENT_B_MODEL: "claude-haiku-5-5" }), candidates: [{ scenario: base, submissions: subs, audit: { scored: REAL_KINDS, separate: NOISE_KINDS, contradictory: CONTRADICTORY_KINDS } }],
    predefined: { interpretationA: "An opportunistic theft.", interpretationB: "A staged theft." }, options, log: (s) => logs.push(s), generate: fn, persistent: { waitMs: 0 },
  });
  const out = logs.join("\n");
  assert.equal(r.outcome, "incomplete");
  assert.equal(r.turnsDone, 0);
  assert.deepEqual(calls, ["opening", "opening", "turn"]); // no judge call
  assert.match(out, /BENCHMARK INCOMPLETE: a debate turn failed after 0 successful turn\(s\)/);
  assert.match(out, /Turn 3, Agent A: ERROR \[truncated\]/);
  assert.match(out, /failed request still used 2100 input \/ 1400 output tokens/);
  assert.match(out, /REPRESENTED in a SUCCESSFUL debating turn 0 \(0\.0%\)/);
  assert.match(out, /AUDIENCE REPRESENTED: 0 of 200 submissions \(0\.0%\)/);
  assert.match(out, /ingested into the persistent state 40 of 200/); // only what had arrived by Turn 3 (20 per side) was ingested
  assert.match(out, /MODEL REQUESTS: attempted 3 \| successful 2 \| failed 1/);
  assert.match(out, /PARTIAL USAGE COST \(this run did not complete/);
  assert.doesNotMatch(out, /ESTIMATED TOTAL COST/);
  assert.doesNotMatch(out, /PHASE 6: INDEPENDENT JUDGE[\s\S]*Winner/);
  // the failed request's tokens are in the partial cost: 2 openings (800/60) + 1 failed turn (2100/1400) on Haiku
  assert.match(out, /model claude-haiku-5-5: 3 request\(s\), tokens in\/out 3700\/1520/);
});
