import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { RECONCILE_SYSTEM, applyThemeDelta, buildThemeBriefing, createAudienceThemeState, ingestSubmissions, parseAudienceThemeState } from "../src/themes";
import { JUDGE_SYSTEM } from "../src/prompts";
import type { AudienceInjection, EngineConfig, GenerateTextFn, Side } from "../src/types";
import { config as baseConfig, scenario, mockGenerate } from "./fixtures";

const config: EngineConfig = {
  ...baseConfig,
  injections: { maxPerAgent: 3, maxChars: 200 },
  reconciler: { provider: "anthropic", model: "mock-reconciler", maxOutputTokens: 500, timeoutMs: 1000, maxRetries: 0 },
};
const mk = (id: string, side: Side, text: string, t: number, playerId?: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });
const people = (n: number, side: Side, text: (k: number) => string, prefix: string, t0 = 0) => Array.from({ length: n }, (_, k) => mk(`${prefix}${k}`, side, text(k), t0 + k, `${prefix}-p${k}`));

/** Mock reconciler: groups themes whose text maps to the same non-empty "meaning" (decided by the test, not by word overlap). */
function reconcilerMock(meaning: (text: string) => string, opts: { failTimes?: number; garbage?: boolean } = {}) {
  let fails = opts.failTimes ?? 0;
  const prompts: string[] = [];
  const m = mockGenerate((_cfg, req) => {
    if (req.system !== RECONCILE_SYSTEM) return "an argument";
    prompts.push(req.prompt);
    if (fails-- > 0) return new Error("reconciler down");
    if (opts.garbage) return "not json";
    const list = (label: string) => JSON.parse(req.prompt.split(`${label} (JSON): `)[1].split("\n")[0]) as { id: string; text: string }[];
    const all = [...list("EXISTING THEMES"), ...list("NEW THEMES")];
    const g = new Map<string, string[]>();
    for (const t of all) {
      const k = meaning(t.text);
      if (k) g.set(k, [...(g.get(k) ?? []), t.id]);
    }
    return JSON.stringify({ groups: [...g.values()].filter((x) => x.length > 1) });
  });
  return { ...m, prompts, reconcileCalls: () => m.calls.filter((c) => c.req.system === RECONCILE_SYSTEM).length };
}
const insuranceMeaning = (t: string) => (/does ?n.t (mean|prove)|proves nothing|timing establishes|not.*motive/i.test(t) ? "insurance-nothing" : /proves fraud/i.test(t) ? "insurance-fraud" : /logbook/i.test(t) ? "logbook" : "");

const nothing = "The insurance renewal proves nothing.";
const dm = "A renewal date doesn't mean fraud.";
const timing = "Challenge the claim that the insurance timing establishes a motive.";
const fraud = "The insurance renewal proves fraud.";
const notFraud = "The insurance renewal does not prove fraud.";

test("exact duplicates and a repeating player: a player counts once per theme, every message is kept in the accounting", () => {
  const all = [...Array.from({ length: 20 }, (_, k) => mk(`r${k}`, "A", "Check the logbook!", k, "spammer")), mk("o", "A", "check the LOGBOOK", 30, "other"), mk("anon", "A", "Check the logbook", 31)];
  const r = ingestSubmissions(createAudienceThemeState("r", "A"), all, 200);
  assert.equal(r.state.themes.length, 1);
  const t = r.state.themes[0];
  assert.deepEqual([t.players.length, t.messages, t.anonymous, t.sourceIds.length], [2, 22, 1, 22]);
  assert.equal(r.absorbedIds.length, 22);
});

test("support accumulates across turns: 50, then 70, then 80 distinct supporters, newSupporters per briefing, nothing double-counted", async () => {
  const m = mockGenerate();
  const engine = createDebateEngine(config, { generate: m.fn });
  let state = createAudienceThemeState("r", "A");
  const batches = [people(50, "A", () => nothing, "a"), people(20, "A", () => nothing, "b", 100), people(10, "A", () => nothing, "c", 200)];
  const seen: AudienceInjection[] = [];
  const supporters: [number, number][] = [];
  for (const [i, b] of batches.entries()) {
    seen.push(...b);
    const transcript = Array.from({ length: i * 2 }, (_, k) => ({ stage: "turn" as const, side: (k % 2 ? "B" : "A") as Side, text: "x", turn: k + 1 }));
    const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, transcript, injections: seen, audienceThemeState: state }); // whole list passed every time
    assert.ok(r.ok && r.briefing && r.audienceThemeState);
    supporters.push([r.briefing.themes[0].supporters, r.briefing.themes[0].newSupporters]);
    assert.equal(r.audience.stats.absorbed, b.length); // only the new ones are absorbed
    state = r.audienceThemeState;
    assert.equal(state.themes[0].briefedTurns.length, i + 1);
  }
  assert.deepEqual(supporters, [[50, 50], [70, 20], [80, 10]]);
  assert.equal(state.themes.length, 1);
  assert.match(m.calls[2].req.prompt, /"supporters":80,"newSupporters":10/);
  assert.match(m.calls[2].req.prompt, /"briefedBefore":true/);
});

test("themes that are not in a briefing keep their counts in the state and appear again later", async () => {
  const engine = createDebateEngine({ ...config, themes: { briefingThemes: 3 } }, { generate: mockGenerate().fn });
  const all = [...people(5, "A", () => "popular idea", "p"), ...Array.from({ length: 10 }, (_, k) => mk(`s${k}`, "A", `single idea ${k}`, 50 + k, `sp${k}`))];
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: all, audienceThemeState: createAudienceThemeState("r", "A") });
  assert.ok(r.ok && r.briefing && r.audienceThemeState);
  assert.equal(r.briefing.themes.length, 3);
  assert.equal(r.briefing.omitted, 8);
  assert.equal(r.audienceThemeState.themes.length, 11);
  assert.equal(r.audienceThemeState.themes.find((t) => t.suggestion === "popular idea")!.players.length, 5);
});

test("semantic reconciliation merges equivalent wordings into the earliest theme id, using the union of players", async () => {
  const rec = reconcilerMock(insuranceMeaning);
  const engine = createDebateEngine(config, { generate: rec.fn });
  const all = [...people(3, "A", () => nothing, "a"), ...people(3, "A", () => dm, "b", 10), ...people(3, "A", () => timing, "c", 20)];
  const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all });
  assert.equal(res.report.status, "complete");
  assert.equal(res.state.themes.length, 1);
  const t = res.state.themes[0];
  assert.equal(t.id, "t1"); // stable: the oldest theme survives
  assert.deepEqual([t.players.length, t.messages, t.sourceIds.length, t.mergedFrom.sort()], [9, 9, 9, ["t2", "t3"]]);
  assert.deepEqual(res.report.pendingThemeIds, []);
  assert.equal(res.report.requests, 1);
  assert.match(rec.prompts[0], /EXISTING THEMES/);
});

test("opposite meanings are never merged by the engine's own logic, and invalid model groups are dropped", async () => {
  const rec = reconcilerMock(insuranceMeaning);
  const engine = createDebateEngine(config, { generate: rec.fn });
  const all = [mk("1", "A", fraud, 1, "p1"), mk("2", "A", notFraud, 2, "p2"), mk("3", "A", nothing, 3, "p3")];
  const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all });
  assert.equal(res.state.themes.length, 2); // "does not prove fraud" ~ "proves nothing" merge; "proves fraud" stays apart
  const fraudTheme = res.state.themes.find((t) => t.suggestion === fraud)!;
  assert.deepEqual(fraudTheme.players, ["p1"]);
  assert.match(RECONCILE_SYSTEM, /opposite meanings/);
  // a model that merges everything with unknown ids and existing-only groups is partially ignored
  const bad = mockGenerate(() => JSON.stringify({ groups: [["t1", "t2", "t99"], ["t3"], ["t1", "t1"]] }));
  const e2 = createDebateEngine(config, { generate: bad.fn });
  const r2 = await e2.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all });
  assert.equal(r2.state.themes.length, 3);
  assert.deepEqual(r2.report.pendingThemeIds, []);
});

test("one recommendation per player: a second, differently worded submission is kept but never adds support; merging uses the union", async () => {
  const rec = reconcilerMock(insuranceMeaning);
  const engine = createDebateEngine(config, { generate: rec.fn });
  const all = [mk("1", "A", nothing, 1, "alice"), mk("2", "A", nothing, 2, "bob"), mk("3", "A", dm, 3, "bob"), mk("4", "A", dm, 4, "carol"), mk("5", "A", timing, 5, "alice")];
  const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all });
  assert.equal(res.state.themes.length, 1);
  assert.deepEqual(res.state.themes[0].players.sort(), ["alice", "bob", "carol"]);
  assert.equal(res.state.themes[0].messages, 3); // alice, bob, carol: their first submissions
  assert.deepEqual(res.state.extras.map((e) => [e.id, e.playerId, e.text]), [["3", "bob", dm], ["5", "alice", timing]]); // original text + ID preserved
  assert.equal(res.state.themes[0].sourceIds.length + res.state.extras.length, 5); // nothing lost
});

test("out-of-order and late arrivals: timestamps are min/max, counts stay exact, existing support is kept", () => {
  const first = ingestSubmissions(createAudienceThemeState("r", "A"), [mk("b", "A", nothing, 500, "p2"), mk("a", "A", nothing, 100, "p1")], 200);
  const later = ingestSubmissions(first.state, [mk("late", "A", nothing, 50, "p3"), mk("a", "A", nothing, 100, "p1"), mk("c", "A", nothing, 900, "p1")], 200);
  const t = later.state.themes[0];
  assert.deepEqual([t.firstAt, t.latestAt, t.players.length, t.messages], [50, 900, 3, 4]);
  assert.equal(later.alreadyKnown, 1);
  assert.equal(first.state.themes[0].players.length, 2); // input state is not mutated
});

test("temporary reconciliation failures lose nothing: themes stay counted and pending, a later call merges them", async () => {
  const rec = reconcilerMock(insuranceMeaning, { failTimes: 1 });
  const engine = createDebateEngine(config, { generate: rec.fn });
  const all = [...people(4, "A", () => nothing, "a"), ...people(4, "A", () => dm, "b", 10)];
  const r1 = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all });
  assert.equal(r1.report.status, "failed");
  assert.equal(r1.report.errors[0].kind, "timeout");
  assert.equal(r1.state.themes.length, 2);
  assert.deepEqual(r1.report.pendingThemeIds, ["t1", "t2"]);
  assert.equal(r1.state.themes.reduce((n, t) => n + t.messages, 0), 8);
  // the turn still gets a briefing from the last completed state, with the pending marker
  const turn = await createDebateEngine(config, { generate: mockGenerate().fn }).generateNextTurn({ roundId: "r", speaker: "A", scenario, audienceThemeState: r1.state });
  assert.ok(turn.ok && turn.briefing!.themes.every((t) => t.grouping === "pending"));
  const r2 = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, previousState: r1.state });
  assert.equal(r2.report.status, "complete");
  assert.deepEqual([r2.state.themes.length, r2.state.themes[0].players.length], [1, 8]);
  const g = createDebateEngine(config, { generate: reconcilerMock(() => "", { garbage: true }).fn });
  const r3 = await g.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all });
  assert.equal(r3.report.errors[0].kind, "invalid_output");
  assert.equal(r3.state.themes.length, 2);
});

test("without a configured reconciler only exact grouping runs (status unavailable), and nothing is lost", async () => {
  const { reconciler: _r, ...noRec } = config;
  const engine = createDebateEngine(noRec, { generate: mockGenerate().fn });
  const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: [mk("1", "A", "x one", 1, "p")] });
  assert.equal(res.report.status, "unavailable");
  assert.equal(res.state.themes.length, 1);
});

test("200, 500 and 1000 submissions: bounded requests, every ID in exactly one theme, exact distinct-player counts", async () => {
  for (const n of [200, 500, 1000]) {
    const rec = reconcilerMock((t) => (t.startsWith("insurance variant") ? "ins" : t.startsWith("logbook variant") ? "log" : ""));
    const engine = createDebateEngine({ ...config, themes: { maxRequests: 3, maxNewPerRequest: 40, maxExistingPerRequest: 30 } }, { generate: rec.fn });
    const all: AudienceInjection[] = [
      ...people(50, "A", (k) => `insurance variant ${k % 7} ${k}`, "i"),
      ...people(30, "A", (k) => `logbook variant ${k}`, "l", 100),
      mk("irr", "A", "my cat sat on the keyboard", 200, "pz"),
      ...people(n - 81, "A", (k) => `unrelated filler ${k}`, "f", 300),
      ...people(5, "B", () => "B-only idea", "bb"),
    ];
    let state = createAudienceThemeState("r", "A");
    let requests = 0;
    for (let call = 0; call < 40 && (call === 0 || state.themes.some((t) => !t.reviewed)); call++) {
      const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, previousState: state, newSubmissions: all });
      assert.ok(res.report.requests <= 3);
      requests += res.report.requests;
      state = res.state;
    }
    assert.ok(state.themes.every((t) => t.reviewed));
    const ids = state.themes.flatMap((t) => t.sourceIds);
    assert.equal(ids.length, n);
    assert.equal(new Set(ids).size, n);
    assert.equal(state.themes.reduce((a, t) => a + t.messages, 0), n);
    assert.ok(!ids.some((id) => id.startsWith("bb")));
    const ins = state.themes.find((t) => t.players.includes("i-p0"))!;
    assert.equal(ins.players.length, 50);
    assert.equal(state.themes.find((t) => t.players.includes("l-p0"))!.players.length, 30);
    assert.ok(requests <= Math.ceil(n / 40) + 3, `n=${n} used ${requests} requests`);
    const b = buildThemeBriefing(state, { briefingThemes: 8 });
    assert.ok(b.themes.length <= 8 && b.themes[0].supporters === 50 && b.themes[1].supporters === 30);
    assert.ok(JSON.stringify(b.themes).length < 4500);
  }
});

test("one reconcile call is bounded: at most maxRequests, the rest stays pending but counted", async () => {
  const rec = reconcilerMock(() => "");
  const engine = createDebateEngine({ ...config, themes: { maxRequests: 2, maxNewPerRequest: 10 } }, { generate: rec.fn });
  const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: people(100, "A", (k) => `idea ${k}`, "x") });
  assert.equal(res.report.requests, 2);
  assert.equal(res.report.status, "partial");
  assert.equal(res.report.pendingThemeIds.length, 80);
  assert.equal(res.state.themes.length, 100);
});

test("reconciliation never blocks a turn: a turn on the stored state completes while it is in flight, then the delta applies to the newer state", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inner = reconcilerMock(insuranceMeaning);
  const slow: GenerateTextFn = async (cfg, req) => {
    if (req.system === RECONCILE_SYSTEM) await gate;
    return inner.fn(cfg, req);
  };
  const engine = createDebateEngine(config, { generate: slow });
  const stored = ingestSubmissions(createAudienceThemeState("r", "A"), [...people(2, "A", () => nothing, "a"), ...people(2, "A", () => dm, "b", 10)], 200).state;
  const pending = engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, previousState: stored });
  const turn = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, audienceThemeState: stored, injections: [mk("new", "A", "a brand new idea", 99, "newbie")] });
  assert.ok(turn.ok);
  assert.equal(turn.briefing!.themes.length, 3); // unmerged state used; the new message was absorbed
  release();
  const done = await pending;
  const merged = applyThemeDelta(turn.audienceThemeState!, done.delta); // latest state, not the stale one
  assert.equal(merged.themes.length, 2);
  assert.equal(merged.themes.find((t) => t.id === "t1")!.players.length, 4);
  assert.ok(merged.themes.some((t) => t.suggestion === "a brand new idea"));
  assert.deepEqual(applyThemeDelta(merged, done.delta), merged); // idempotent
});

test("consumed IDs and previously processed submissions never change counts again", async () => {
  const engine = createDebateEngine(config, { generate: mockGenerate().fn });
  const all = people(5, "A", () => nothing, "a");
  const t1 = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: all, audienceThemeState: createAudienceThemeState("r", "A") });
  assert.ok(t1.ok);
  const t2 = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: all, audienceThemeState: t1.audienceThemeState });
  assert.ok(t2.ok);
  assert.equal(t2.audience.stats.absorbed, 0);
  assert.equal(t2.audience.stats.alreadyConsumed, 5);
  assert.equal(t2.audienceThemeState!.themes[0].messages, 5);
  assert.equal(t2.briefing!.themes[0].newSupporters, 0);
  const consumed = ingestSubmissions(createAudienceThemeState("r", "A"), all, 200, new Set(["a0", "a1"]));
  assert.equal(consumed.state.themes[0].messages, 3);
});

test("privacy: Agent B never sees A's themes; a state of the wrong side/round is refused; the judge sees no audience data", async () => {
  const m = mockGenerate();
  const engine = createDebateEngine(config, { generate: m.fn });
  const all = [...people(30, "A", () => "SECRET-A plan", "a"), ...people(30, "B", () => "SECRET-B plan", "b")];
  const stateA = ingestSubmissions(createAudienceThemeState("r", "A"), all, 200).state;
  const stateB = ingestSubmissions(createAudienceThemeState("r", "B"), all, 200).state;
  assert.ok(stateA.themes.every((t) => t.suggestion.includes("SECRET-A")) && stateB.themes.every((t) => t.suggestion.includes("SECRET-B")));
  const wrong = await engine.generateNextTurn({ roundId: "r", speaker: "B", scenario, injections: all, audienceThemeState: stateA });
  assert.ok(!wrong.ok && wrong.error.kind === "config");
  assert.equal(m.calls.length, 0);
  const wrongRound = await engine.generateNextTurn({ roundId: "other", speaker: "A", scenario, injections: all, audienceThemeState: stateA });
  assert.ok(!wrongRound.ok);
  const b = await engine.generateNextTurn({ roundId: "r", speaker: "B", scenario, injections: all, audienceThemeState: stateB });
  assert.ok(b.ok);
  assert.ok(!m.calls[0].req.prompt.includes("SECRET-A") && m.calls[0].req.prompt.includes("SECRET-B"));
  assert.ok(!m.calls[0].req.system.includes("SECRET"));
  const rec = reconcilerMock(() => "");
  await createDebateEngine(config, { generate: rec.fn }).reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: all, previousState: ingestSubmissions(createAudienceThemeState("r", "A"), all, 200).state });
  assert.ok(rec.prompts.every((p) => !p.includes("SECRET-B")));
  const j = await engine.judgeDebate({ roundId: "r", scenario, transcript: [{ stage: "turn", side: "A", text: "a", turn: 1 }, { stage: "turn", side: "B", text: "b", turn: 2 }] });
  assert.ok(j.ok === false || j.ok === true);
  const jp = m.calls.at(-1)!;
  assert.equal(jp.req.system, JUDGE_SYSTEM);
  assert.ok(!/SECRET|supporters|players|briefing|theme/i.test(jp.req.prompt));
});

test("state serialises to JSON and restores exactly; corrupt state is rejected", async () => {
  const rec = reconcilerMock(insuranceMeaning);
  const engine = createDebateEngine(config, { generate: rec.fn });
  const res = await engine.reconcileAudienceThemes({ roundId: "r", side: "A", scenario, newSubmissions: [...people(3, "A", () => nothing, "a"), ...people(3, "A", () => dm, "b", 9), mk("blank", "A", "  ", 1, "x")] });
  const back = parseAudienceThemeState(JSON.stringify(res.state));
  assert.ok(back.ok);
  assert.deepEqual(back.state, res.state);
  assert.deepEqual(res.state.invalidIds, ["blank"]);
  assert.equal(parseAudienceThemeState("{nope").ok, false);
  assert.equal(parseAudienceThemeState({ ...res.state, version: 2 }).ok, false);
  const again = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, audienceThemeState: back.state });
  assert.ok(again.ok);
});

test("prompt size stays bounded however many themes exist, and audience text is only in the user prompt", async () => {
  const m = mockGenerate();
  const engine = createDebateEngine(config, { generate: m.fn });
  const all = people(1000, "A", (k) => `distinct suggestion number ${k} ` + "z".repeat(150), "x");
  const base = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario });
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: all, audienceThemeState: createAudienceThemeState("r", "A") });
  assert.ok(base.ok && r.ok);
  assert.ok(m.calls[1].req.prompt.length - m.calls[0].req.prompt.length < 20_000 + 12_000);
  assert.equal(r.audienceThemeState!.themes.length, 1000);
  // overflow: exact accounting of what the agent saw and what it did not
  assert.ok(r.audience.includedIds.length > 0 && r.audience.queuedIds.length > 0);
  assert.equal(r.audience.includedIds.length + r.audience.queuedIds.length, 1000);
  assert.ok(r.audience.includedIds.every((id) => !r.audience.queuedIds.includes(id)));
  assert.ok(r.audience.includedIds.includes("x0") && r.audience.includedIds.includes("x999")); // oldest and newest both represented
  assert.ok(r.briefing!.chars <= 20_000);
  assert.ok(!m.calls[1].req.system.includes("distinct suggestion"));
  assert.match(m.calls[1].req.prompt, /Popularity never makes a claim true or verified/);
});

test("backward compatibility: without a theme state the sequential API is unchanged (no state returned)", async () => {
  const engine = createDebateEngine(config, { generate: mockGenerate().fn });
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: people(5, "A", (k) => `idea ${k}`, "x") });
  assert.ok(r.ok && r.audienceThemeState === undefined && r.briefing === undefined);
  assert.equal(r.audience.includedIds.length, 5);
});
