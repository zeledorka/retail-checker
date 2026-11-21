import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { createThemeCoordinator } from "../src/coordinator";
import type { AudienceInjection, EngineConfig, GenerateTextFn, Side } from "../src/types";
import { config as baseConfig, scenario, mockGenerate } from "./fixtures";

const config: EngineConfig = { ...baseConfig, injections: { maxPerAgent: 3, maxChars: 200 } };
const mk = (id: string, side: Side, text: string, t: number, playerId?: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });
const briefed = (prompt: string) => (JSON.parse(prompt.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { suggestion: string; supporters: number }[] }).themes;
const turnOf = (n: number) => Array.from({ length: n }, (_, k) => ({ stage: "turn" as const, side: (k % 2 ? "B" : "A") as Side, text: "x", turn: k + 1 }));

test("a submission that arrived before the request begins is in that request (ingest -> state -> briefing -> request)", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("s1", "A", "arrived before", 1, "p1")]); // received at the turn boundary
  await coord.nextTurn({ speaker: "A", injections: [mk("s2", "A", "passed with the turn call", 2, "p2")] });
  assert.deepEqual(briefed(m.calls[0].req.prompt).map((t) => t.suggestion).sort(), ["arrived before", "passed with the turn call"]);
});

test("a submission arriving DURING an active request is not injected into it; it is in the speaker's next request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const prompts: string[] = [];
  const fn: GenerateTextFn = async (cfg, req) => {
    prompts.push(req.prompt);
    if (prompts.length === 1) await gate;
    return { ok: true, result: { text: "an argument", provider: "anthropic", model: cfg.model, latencyMs: 5 } };
  };
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: fn }), { roundId: "r", scenario });
  coord.submit([mk("s1", "A", "before the request", 1, "p1")]);
  const first = coord.nextTurn({ speaker: "A" }); // request now in flight
  await new Promise((r) => setTimeout(r, 5));
  coord.submit([mk("s2", "A", "during the request", 2, "p2")]);
  release();
  const r1 = await first;
  assert.ok(r1.result.ok);
  assert.ok(!prompts[0].includes("during the request"));
  assert.equal(coord.audit("A").missing, 0); // it is stored, not lost
  await coord.nextTurn({ speaker: "A", transcript: turnOf(2) });
  assert.deepEqual(briefed(prompts[1]).map((t) => t.suggestion).sort(), ["before the request", "during the request"]);
});

test("the opponent's audience is never included, in either direction", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("a", "A", "ONLY-FOR-A", 1, "pa"), mk("b", "B", "ONLY-FOR-B", 2, "pb")]);
  await coord.nextTurn({ speaker: "A" });
  await coord.nextTurn({ speaker: "B", transcript: turnOf(1) });
  assert.ok(m.calls[0].req.prompt.includes("ONLY-FOR-A") && !m.calls[0].req.prompt.includes("ONLY-FOR-B"));
  assert.ok(m.calls[1].req.prompt.includes("ONLY-FOR-B") && !m.calls[1].req.prompt.includes("ONLY-FOR-A"));
});

test("a second submission from the same player is defensively ignored: stored, never counted", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("1", "A", "first idea", 1, "same"), mk("2", "A", "a different idea", 2, "same"), mk("3", "A", "first idea!", 3, "same")]);
  const t = await coord.nextTurn({ speaker: "A" });
  assert.ok(t.result.ok);
  const items = briefed(m.calls[0].req.prompt);
  assert.deepEqual(items.map((i) => [i.suggestion, i.supporters]), [["first idea", 1]]); // the repeat and the different wording add nothing
  assert.deepEqual(t.result.audience.ignoredIds, ["2"]);
  const a = coord.audit("A");
  assert.deepEqual([a.received, a.missing, a.ignored], [3, 0, 1]);
});

test("late submissions after the agent's final request are stored and reported as unable to influence any argument", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("early", "A", "early idea", 1, "p1")]);
  await coord.nextTurn({ speaker: "A" }); // Agent A's last request
  coord.submit([mk("late", "A", "late idea", 2, "p2")]);
  assert.deepEqual(coord.neverBriefed("A"), ["late"]);
  assert.equal(coord.audit("A").missing, 0);
  assert.ok(!m.calls[0].req.prompt.includes("late idea"));
});

test("no submissions: the debate continues normally with plain-text arguments and no audience block", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  const t = await coord.nextTurn({ speaker: "A" });
  assert.ok(t.result.ok && t.result.audienceAnalysis === undefined);
  assert.ok(!m.calls[0].req.prompt.includes("AUDIENCE BRIEFING"));
  assert.equal(coord.audit("A").received, 0);
});

test("persistent counts never reset: support only grows across turns, new arrivals add to existing ideas", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  const seen: number[] = [];
  let players = 0;
  for (let turn = 0; turn < 4; turn++) {
    const batch = turn === 2 ? [] : Array.from({ length: 5 }, (_, k) => mk(`t${turn}-${k}`, "A", "insurance renewal proves nothing", 100 * turn + k, `p${players++}`));
    await coord.nextTurn({ speaker: "A", injections: batch, transcript: turnOf(turn) });
    seen.push(briefed(m.calls[turn].req.prompt)[0].supporters);
  }
  assert.deepEqual(seen, [5, 10, 10, 15]);
  assert.equal(coord.audit("A").missing, 0);
});

test("root cause of the observed delay: the benchmark schedule used loop indexes while the engine counts transcript entries (openings included)", () => {
  // The first sequential request is Turn 3 (two openings are already in the transcript), not turn 1.
  const engine = createDebateEngine(config, { generate: mockGenerate().fn });
  return engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, transcript: [{ stage: "opening", side: "A", text: "a" }, { stage: "opening", side: "B", text: "b" }] }).then((r) => {
    assert.ok(r.ok);
    assert.equal(r.turn, 3);
  });
});
