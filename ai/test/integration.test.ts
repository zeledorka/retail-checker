import { test } from "node:test";
import assert from "node:assert/strict";
import { createAiRound, parseRoundState, publicRoundView, serializeRound, startRound, loadEngineConfig } from "../src/index";
import type { AiRoundState, AudienceSubmission, GenerateOutcome, GenerateTextFn, Scenario } from "../src/index";
import { JUDGE_SYSTEM } from "../src/prompts";
import { mockProvider, runMockRound } from "../examples/mock-round";
import { verdictJson } from "./fixtures";

const scenario: Scenario = {
  title: "The Empty Display Case",
  description: "A museum alarm sounded at 2 a.m. and a minor painting's case was found open and empty.",
  evidence: ["The alarm sounded at 2 a.m.", "No sign of forced entry"],
  interpretationA: "An opportunistic theft by someone with the case keys.",
  interpretationB: "The theft was staged to support a future insurance claim.",
};
const config = loadEngineConfig({});
const filler = (n: number) => Array.from({ length: n }, (_, k) => (k === 0 ? "Evidence" : "evidence")).join(" ");

type Call = { role: string; system: string; prompt: string; model: string };
/** A provider whose behaviour per call can be scripted (fail the Nth call, return long text, ...). */
function provider(opts: { failCall?: (n: number, role: string) => GenerateOutcome | undefined; longArgs?: boolean } = {}) {
  const calls: Call[] = [];
  const fn: GenerateTextFn = async (cfg, req) => {
    const role = req.system === JUDGE_SYSTEM ? "judge" : req.system.includes("Output format for this turn") ? "turn" : "opening";
    calls.push({ role, system: req.system, prompt: req.prompt, model: cfg.model });
    const forced = opts.failCall?.(calls.length, role);
    if (forced) return forced;
    let text = opts.longArgs ? `${filler(30)}. ${filler(30)}.` : "An opening argument that stays inside the limit.";
    if (role === "judge") text = verdictJson();
    if (role === "turn") {
      const ids = (JSON.parse(req.prompt.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { id: string }[] }).themes.map((t) => t.id);
      text = JSON.stringify({ argument: opts.longArgs ? `${filler(30)}. ${filler(30)}.` : "A turn argument.", audienceAnalysis: { groups: [{ label: "idea", wordingIds: ids.join(" "), relevance: "high", used: true }], unassigned: {} } });
    }
    return { ok: true, result: { text, provider: "anthropic", model: cfg.model, latencyMs: 5, inputTokens: 100, outputTokens: 50 } };
  };
  return { fn, calls };
}
const fail = (kind: "timeout" | "truncated" | "provider_error", extra: object = {}): GenerateOutcome => ({ ok: false, error: { kind, message: `${kind} (test)`, provider: "anthropic", model: "claude-sonnet-5-5", retryable: kind !== "truncated", ...extra } });
const start = (maxTurns?: number): AiRoundState => {
  const r = startRound({ roundId: "room-1:round-1", scenario, maxTurns });
  assert.ok(r.ok);
  return r.state;
};
const sub = (id: string, side: "A" | "B", text: string, playerId: string, t = 1): AudienceSubmission => ({ id, side, text, submittedAt: t, playerId });
/** A state saved to JSON and restored, as between two serverless invocations. */
const roundTrip = (s: AiRoundState): AiRoundState => {
  const r = parseRoundState(serializeRound(s));
  assert.ok(r.ok);
  return r.state;
};
async function openings(ai: ReturnType<typeof createAiRound>, s: AiRoundState) {
  let state = s;
  for (const side of ["A", "B"] as const) {
    const o = await ai.generateOpening(roundTrip(state), side);
    assert.ok(o.ok);
    state = o.state;
  }
  return state;
}

test("startRound validates the scenario, the locked interpretations and the round id; it never calls a model", () => {
  const bad = (over: Partial<Scenario>) => startRound({ roundId: "r1", scenario: { ...scenario, ...over } });
  for (const r of [
    startRound({ roundId: "bad id!", scenario }),
    startRound({ roundId: "", scenario }),
    bad({ evidence: [] }),
    bad({ title: "  " }),
    bad({ interpretationB: scenario.interpretationA.toUpperCase() }),
    bad({ interpretationA: "" }),
    startRound({ roundId: "r1", scenario, maxTurns: 0 }),
    startRound({ roundId: "r1", scenario: null as never }),
  ]) {
    assert.ok(!r.ok);
    assert.deepEqual([r.error.code, r.error.retryable, r.error.modelCalled], ["invalid_scenario", false, false]);
  }
  const s = start();
  assert.deepEqual([s.version, s.revision, s.maxTurns, s.closed, s.transcript.length], [1, 0, 8, false, 0]);
  assert.deepEqual(s.scenario, scenario);
});

test("the production defaults are used: Claude Sonnet 5.5 at low effort for Agent A, Agent B and the judge", () => {
  const ai = createAiRound(loadEngineConfig({}));
  for (const m of [ai.config.agentA, ai.config.agentB, ai.config.judge]) assert.deepEqual([m.provider, m.model, m.effort], ["anthropic", "claude-sonnet-5-5", "low"]);
  assert.equal(ai.config.publicWordLimit, undefined); // engine default: 45
});

test("a complete round across separate 'invocations' makes exactly 11 requests, 8 alternating turns and one verdict", async () => {
  const r = await runMockRound();
  assert.equal(r.calls.length, 11);
  assert.deepEqual(r.view.transcript.map((a) => [a.sequence, a.side, a.stage]), [
    [1, "A", "opening"], [2, "B", "opening"], [3, "A", "turn"], [4, "B", "turn"], [5, "A", "turn"], [6, "B", "turn"], [7, "A", "turn"], [8, "B", "turn"], [9, "A", "turn"], [10, "B", "turn"],
  ]);
  assert.deepEqual(r.view.transcript.filter((a) => a.stage === "turn").map((a) => a.debateTurn), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(r.view.status, "judged");
  assert.equal(r.view.turnsCompleted, 8);
  assert.equal(r.calls.filter((c) => c.role === "judge").length, 1);
});

test("state survives serialisation: a round run with save/restore between every call equals one run in memory", async () => {
  const run = async (restore: boolean) => {
    const p = provider();
    const ai = createAiRound(config, { generate: p.fn });
    const all: AudienceSubmission[] = [];
    let s = start();
    s = await openings(ai, s);
    for (let n = 1; n <= 8; n++) {
      if (n === 1) all.push(sub("a1", "A", "challenge the insurance motive", "pa1"), sub("b1", "B", "the alarm creates a timeline", "pb1"));
      if (n === 4) all.push(sub("a2", "A", "the log is unreadable", "pa2"), sub("b2", "B", "renewal week is suspicious", "pb2"));
      const t = await ai.nextTurn(restore ? roundTrip(s) : s, { submissions: all });
      assert.ok(t.ok);
      s = t.state;
    }
    const j = await ai.judge(restore ? roundTrip(s) : s);
    assert.ok(j.ok);
    return { state: j.state, calls: p.calls.length };
  };
  const [a, b] = [await run(false), await run(true)];
  assert.deepEqual(a.state, b.state);
  assert.deepEqual([a.calls, b.calls], [11, 11]);
  assert.equal(a.state.revision, 11); // one revision per committed step
  assert.deepEqual(JSON.parse(serializeRound(a.state)), JSON.parse(JSON.stringify(a.state)));
});

test("audience submissions are neither lost nor duplicated: cumulative resends are idempotent and both sides keep their own", async () => {
  const p = provider();
  const ai = createAiRound(config, { generate: p.fn });
  let s = await openings(ai, start());
  const first = [sub("a1", "A", "idea one", "pa1"), sub("a2", "A", "idea two", "pa2"), sub("b1", "B", "other one", "pb1")];
  const t1 = await ai.nextTurn(roundTrip(s), { submissions: [...first, ...first] }); // the same list twice in one call
  assert.ok(t1.ok);
  s = t1.state;
  assert.deepEqual(s.audience.B.themes.flatMap((t) => t.sourceIds), ["b1"]); // B's message is stored while A speaks
  const later = [...first, sub("a3", "A", "idea three", "pa3"), sub("b2", "B", "other two", "pb2"), sub("a1x", "A", "a different wording", "pa1")]; // pa1 sends a second message
  const t2 = await ai.nextTurn(roundTrip(s), { submissions: later });
  assert.ok(t2.ok);
  const t3 = await ai.nextTurn(roundTrip(t2.state), { submissions: later }); // B speaks, same cumulative list again
  assert.ok(t3.ok);
  s = t3.state;
  const ids = (side: "A" | "B") => s.audience[side].themes.flatMap((t) => t.sourceIds).sort();
  assert.deepEqual(ids("A"), ["a1", "a2", "a3"]);
  assert.deepEqual(s.audience.A.extras.map((e) => e.id), ["a1x"]); // one submission per player: the second is kept but never counted
  assert.deepEqual(ids("B"), ["b1", "b2"]);
  assert.equal(new Set(ids("A")).size, ids("A").length);
  const supporters = s.audience.A.themes.reduce((n, t) => n + t.players.length, 0);
  assert.equal(supporters, 3); // distinct players, not messages
});

test("opposing audiences stay isolated and the judge receives no private data", async () => {
  const p = provider();
  const ai = createAiRound(config, { generate: p.fn });
  let s = await openings(ai, start(4));
  const subs = [sub("a1", "A", "SECRET-FOR-A idea", "player-A-1"), sub("b1", "B", "SECRET-FOR-B idea", "player-B-1")];
  for (let n = 0; n < 4; n++) {
    const t = await ai.nextTurn(roundTrip(s), { submissions: subs });
    assert.ok(t.ok);
    s = t.state;
  }
  const j = await ai.judge(roundTrip(s));
  assert.ok(j.ok);
  const turns = p.calls.filter((c) => c.role === "turn");
  const [turnA, turnB] = [turns.filter((_, i) => i % 2 === 0), turns.filter((_, i) => i % 2 === 1)];
  assert.ok(turnA.every((c) => c.prompt.includes("SECRET-FOR-A") && !c.prompt.includes("SECRET-FOR-B")));
  assert.ok(turnB.every((c) => c.prompt.includes("SECRET-FOR-B") && !c.prompt.includes("SECRET-FOR-A")));
  assert.ok(p.calls.filter((c) => c.role === "opening").every((c) => !/SECRET|player-/.test(c.prompt + c.system)));
  const judge = p.calls.find((c) => c.role === "judge")!;
  assert.doesNotMatch(judge.prompt, /SECRET|player-A|player-B|supporters|wordingIds|briefing|AUDIENCE|bet|balance/i);
  assert.doesNotMatch(judge.system, /SECRET|player-/);
  // the frontend view carries no audience data at all
  const view = JSON.stringify(publicRoundView(j.state));
  assert.doesNotMatch(view, /SECRET|player-|supporters|audience|sourceIds|playerId/i);
  // the turn result keeps bookkeeping under `private`, apart from the public argument
  const t = await ai.nextTurn(start(4), { submissions: subs });
  assert.ok(!t.ok && t.error.code === "not_ready");
});

test("turn order and repeats: openings first, strict alternation, no future turns, repeats reuse without a model call", async () => {
  const p = provider();
  const ai = createAiRound(config, { generate: p.fn });
  const fresh = start(2);
  const early = await ai.nextTurn(fresh);
  assert.ok(!early.ok && early.error.code === "not_ready" && !early.error.modelCalled && early.error.retryable === false);
  assert.equal(p.calls.length as number, 0);
  const jEarly = await ai.judge(fresh);
  assert.ok(!jEarly.ok && jEarly.error.code === "not_ready");

  let s = await openings(ai, fresh);
  const again = await ai.generateOpening(s, "A"); // repeat: stored opening, no request
  assert.ok(again.ok && again.reused && (p.calls.length as number) === 2);
  const wrong = await ai.nextTurn(s, { speaker: "B" });
  assert.ok(!wrong.ok && wrong.error.code === "wrong_turn");
  const future = await ai.nextTurn(s, { turn: 5 });
  assert.ok(!future.ok && future.error.code === "out_of_order");
  assert.equal(p.calls.length as number, 2);

  const t3 = await ai.nextTurn(s, { turn: 3, speaker: "A" });
  assert.ok(t3.ok && !t3.reused && t3.argument.sequence === 3 && t3.argument.side === "A");
  s = t3.state;
  const repeat = await ai.nextTurn(s, { turn: 3 }); // the same request again (e.g. a retried HTTP call)
  assert.ok(repeat.ok && repeat.reused && repeat.argument.text === t3.argument.text && repeat.private === undefined);
  assert.equal(p.calls.length, 3); // no new model request
  assert.equal(repeat.state.revision, s.revision); // and no state change
  const t4 = await ai.nextTurn(s, { turn: 4 });
  assert.ok(t4.ok && t4.argument.side === "B");
  const done = await ai.nextTurn(t4.state);
  assert.ok(!done.ok && done.error.code === "round_complete");

  const v = await ai.judge(t4.state);
  assert.ok(v.ok && !v.reused && v.complete && v.turnsCompleted === 2);
  const v2 = await ai.judge(v.state); // second request for the verdict: stored, no model call
  assert.ok(v2.ok && v2.reused);
  assert.equal(p.calls.filter((c) => c.role === "judge").length, 1);
  const closed = await ai.nextTurn(v.state);
  assert.ok(!closed.ok && closed.error.code === "round_closed");
  const closedOpening = await ai.generateOpening(v.state, "A");
  assert.ok(!closedOpening.ok && closedOpening.error.code === "round_closed");
});

test("a deadline before all turns: the judge still rules on the partial debate and says it was incomplete", async () => {
  const p = provider();
  const ai = createAiRound(config, { generate: p.fn });
  let s = await openings(ai, start());
  for (let n = 0; n < 3; n++) {
    const t = await ai.nextTurn(s);
    assert.ok(t.ok);
    s = t.state;
  }
  assert.equal(publicRoundView(s).status, "debating");
  const j = await ai.judge(s);
  assert.ok(j.ok);
  assert.deepEqual([j.complete, j.turnsCompleted], [false, 3]);
  assert.equal(publicRoundView(j.state).status, "judged");
});

test("failures leave the state untouched and say whether a retry may help; a retry is a NEW model request", async () => {
  const p = provider({ failCall: (n) => (n === 3 ? fail("timeout") : n === 4 ? fail("truncated", { inputTokens: 2100, outputTokens: 2500 }) : n === 8 ? fail("provider_error") : undefined) });
  const ai = createAiRound(config, { generate: p.fn });
  const s = await openings(ai, start()); // calls 1, 2
  const subs = [sub("a1", "A", "an idea", "pa1")];
  const timedOut = await ai.nextTurn(s, { submissions: subs, timeoutMs: 1000 }); // call 3
  assert.ok(!timedOut.ok);
  assert.deepEqual([timedOut.error.code, timedOut.error.modelErrorKind, timedOut.error.retryable, timedOut.error.modelCalled], ["model_error", "timeout", true, true]);
  assert.equal(timedOut.state, s); // unchanged: same object, same revision, submissions NOT stored
  assert.equal(timedOut.state.audience.A.themes.length, 0);
  const cut = await ai.nextTurn(s, { submissions: subs }); // call 4: truncated, usage reported
  assert.ok(!cut.ok && cut.error.modelErrorKind === "truncated");
  assert.deepEqual(cut.error.usage, { inputTokens: 2100, outputTokens: 2500 });
  const ok = await ai.nextTurn(s, { submissions: subs }); // call 5: the retry succeeds, and the submissions are in it
  assert.ok(ok.ok && !ok.reused);
  assert.equal(ok.state.audience.A.themes.length, 1);
  assert.equal(p.calls.length, 5); // every attempt was a real request: 2 openings + 3 turn attempts
  // judge failure keeps the round open for another attempt
  let st = ok.state;
  for (let n = 0; n < 8; n++) {
    const t = await ai.nextTurn(st, { submissions: subs }); // calls 6,7,(8 fails),...
    if (!t.ok) {
      assert.equal(t.error.modelErrorKind, "provider_error");
      continue;
    }
    st = t.state;
  }
  assert.equal(st.transcript.filter((e) => e.stage === "turn").length, 8);
});

test("model failures during judging and openings are reported cleanly and change nothing", async () => {
  const p = provider({ failCall: (_n, role) => (role === "judge" ? fail("provider_error") : undefined) });
  const ai = createAiRound({ ...config, judgeParseRetries: 0 }, { generate: p.fn });
  const s = await openings(ai, start(1));
  const t = await ai.nextTurn(s);
  assert.ok(t.ok);
  const j = await ai.judge(t.state);
  assert.ok(!j.ok && j.error.code === "model_error");
  assert.equal(j.state, t.state);
  assert.equal(j.state.closed, false);
  const bad = createAiRound(config, { generate: async () => ({ ok: false, error: { kind: "timeout", message: "x", retryable: true } }) });
  const o = await bad.generateOpening(start(), "A");
  assert.ok(!o.ok && o.error.retryable && o.state.revision === 0);
  const malformed = createAiRound({ ...config, judgeParseRetries: 0 }, { generate: async (_c, req) => ({ ok: true, result: { text: req.system === JUDGE_SYSTEM ? "Both were great" : "ok argument", provider: "anthropic", model: "m", latencyMs: 1 } }) });
  let ms = await openings(malformed, start(1));
  const mt = await malformed.nextTurn(ms);
  assert.ok(mt.ok);
  ms = mt.state;
  const mj = await malformed.judge(ms);
  assert.ok(!mj.ok && mj.error.modelErrorKind === "invalid_output" && mj.error.retryable && !mj.state.verdict);
});

test("missing or invalid stored state is rejected, never silently replaced by a new round", () => {
  const good = start();
  for (const raw of [undefined, null, "", "{nope", "[]", JSON.stringify({ ...good, version: 2 }), JSON.stringify({ ...good, roundId: "bad id" }), JSON.stringify({ ...good, scenario: { ...good.scenario, evidence: [] } })]) {
    const r = parseRoundState(raw);
    assert.ok(!r.ok, String(raw).slice(0, 30));
    assert.equal(r.error.code, "invalid_state");
  }
  const ok = parseRoundState(JSON.stringify(good));
  assert.ok(ok.ok);
  assert.deepEqual(ok.state, good);
  // structural tampering
  const withOpenings = (e: object[]) => JSON.stringify({ ...good, transcript: e });
  const open = (side: string) => ({ stage: "opening", side, text: "x" });
  const turn = (side: string, n: number) => ({ stage: "turn", side, text: "x", turn: n });
  assert.ok(!parseRoundState(withOpenings([turn("A", 3)])).ok); // turns before openings
  assert.ok(!parseRoundState(withOpenings([open("B"), open("A")])).ok); // openings in the wrong order
  assert.ok(!parseRoundState(withOpenings([open("A"), open("B"), turn("A", 4)])).ok); // wrong turn number
  assert.ok(!parseRoundState(withOpenings([open("A"), open("B"), turn("B", 3)])).ok); // wrong speaker
  assert.ok(parseRoundState(withOpenings([open("A"), open("B"), turn("A", 3), turn("B", 4)])).ok);
  assert.ok(!parseRoundState(JSON.stringify({ ...good, verdict: { winner: "A", scores: {} } })).ok); // a verdict needs a closed round
  const other = start();
  const foreign = JSON.stringify({ ...good, audience: { A: { ...other.audience.A, roundId: "someone-else" }, B: other.audience.B } });
  assert.ok(!parseRoundState(foreign).ok); // audience from another round
  assert.ok(!parseRoundState(JSON.stringify({ ...good, audience: { A: other.audience.B, B: other.audience.A } })).ok); // sides swapped
});

test("public outputs are bounded and structured: every speech is at most 45 words, even if the model writes 60", async () => {
  const p = provider({ longArgs: true });
  const ai = createAiRound(config, { generate: p.fn });
  const s = await openings(ai, start(2));
  const t = await ai.nextTurn(s, { submissions: [sub("a1", "A", "an idea", "p1")], maxWords: 90 }); // asking for more does not lift the cap
  assert.ok(t.ok);
  const words = (x: string) => x.trim().split(/\s+/).length;
  for (const a of publicRoundView(t.state).transcript) assert.ok(words(a.text) <= 45, `${a.sequence}: ${words(a.text)} words`);
  assert.ok(t.telemetry?.shortened && t.telemetry.wordCountBefore === 60 && t.telemetry.wordCountAfter! <= 45);
  assert.equal(t.private?.originalText?.length ? true : false, true); // the original stays server-side only
  assert.ok(t.private?.analysis?.valid);
  assert.deepEqual(Object.keys(t.argument).sort(), ["debateTurn", "key", "roundId", "sequence", "side", "stage", "text"]);
  assert.ok(!JSON.stringify(t.argument).includes("private"));
});

test("the mock provider of the worked example is what the tests use: no network, no key", async () => {
  const calls: { role: string; model: string; prompt: string }[] = [];
  const ai = createAiRound(config, { generate: mockProvider(calls) });
  const o = await ai.generateOpening(start(), "A");
  assert.ok(o.ok && calls.length === 1 && calls[0].model === "claude-sonnet-5-5");
});
