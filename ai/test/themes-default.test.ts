import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngineConfig, resolveThemeReconciler } from "../src/config";
import { createDebateEngine } from "../src/debate";
import { createThemeCoordinator } from "../src/coordinator";
import { RECONCILE_SYSTEM } from "../src/themes";
import { claudeEngineConfig } from "../scripts/lib";
import type { AudienceInjection, EngineConfig, GenerateTextFn, Side } from "../src/types";
import { config as baseConfig, scenario, mockGenerate } from "./fixtures";

const roles = {
  AGENT_A_PROVIDER: "anthropic", AGENT_A_MODEL: "claude-sonnet-5-5", AGENT_A_EFFORT: "low",
  AGENT_B_PROVIDER: "openrouter", AGENT_B_MODEL: "deepseek/deepseek-v3.2",
  JUDGE_PROVIDER: "anthropic", JUDGE_MODEL: "claude-opus-5-5",
};
const mk = (id: string, side: Side, text: string, t: number, playerId?: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });
const people = (n: number, side: Side, text: (k: number) => string, prefix: string, t0 = 0) => Array.from({ length: n }, (_, k) => mk(`${prefix}${k}`, side, text(k), t0 + k, `${prefix}-p${k}`));

test("default: NO separate reconciler; grouping is the debating agent's job, and the prompt budget covers ~200 participants", () => {
  for (const env of [{ ...roles, ANTHROPIC_API_KEY: "k" }, { ...roles }]) {
    const c = loadEngineConfig(env);
    assert.equal(c.reconciler, undefined);
    assert.equal(c.themesStatus?.state, "disabled");
    assert.match(c.themesStatus!.reason!, /debating agent/);
    assert.deepEqual([c.themes?.briefingThemes, c.themes?.briefingChars], [200, 20_000]);
  }
  assert.equal(claudeEngineConfig({ ANTHROPIC_API_KEY: "k" }).reconciler, undefined);
  assert.equal(createDebateEngine(loadEngineConfig({ ...roles }), { generate: mockGenerate().fn }).themesStatus().state, "disabled");
});

test("optional separate reconciler: THEMES_ENABLED=true reuses the Claude role; without its key or an Anthropic role it is unavailable", () => {
  const c = loadEngineConfig({ ...roles, ANTHROPIC_API_KEY: "k", THEMES_ENABLED: "true" });
  assert.deepEqual([c.reconciler?.provider, c.reconciler?.model, c.themesStatus?.state, c.themesStatus?.source], ["anthropic", "claude-sonnet-5-5", "enabled", "default"]);
  const noKey = loadEngineConfig({ ...roles, THEMES_ENABLED: "true" });
  assert.equal(noKey.reconciler, undefined);
  assert.deepEqual([noKey.themesStatus?.state, noKey.themesStatus?.reason], ["unavailable", "ANTHROPIC_API_KEY is not set"]);
  const allOr = loadEngineConfig({ AGENT_A_PROVIDER: "openrouter", AGENT_A_MODEL: "m/a", AGENT_B_PROVIDER: "openrouter", AGENT_B_MODEL: "m/b", JUDGE_PROVIDER: "openrouter", JUDGE_MODEL: "m/j", OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k", THEMES_ENABLED: "true" });
  assert.equal(allOr.reconciler, undefined);
  assert.match(allOr.themesStatus!.reason!, /no Anthropic role/);
});

test("THEMES_ENABLED=false disables; THEMES_PROVIDER/THEMES_MODEL override but are not required", () => {
  for (const v of ["false", "0", "OFF"]) assert.equal(loadEngineConfig({ ...roles, ANTHROPIC_API_KEY: "k", THEMES_ENABLED: v }).themesStatus?.state, "disabled");
  assert.equal(loadEngineConfig({ ...roles, ANTHROPIC_API_KEY: "k", THEMES_ENABLED: "true" }).themesStatus?.state, "enabled");
  const o = loadEngineConfig({ ...roles, ANTHROPIC_API_KEY: "k", THEMES_MODEL: "claude-haiku-5-5", THEMES_EFFORT: "medium" });
  assert.deepEqual([o.reconciler?.provider, o.reconciler?.model, o.reconciler?.effort, o.themesStatus?.source], ["anthropic", "claude-haiku-5-5", "medium", "override"]);
  const or = loadEngineConfig({ ...roles, ANTHROPIC_API_KEY: "k", THEMES_PROVIDER: "openrouter", THEMES_MODEL: "x/y" });
  assert.equal(or.themesStatus?.reason, "OPENROUTER_API_KEY is not set");
  assert.equal(resolveThemeReconciler({ ...roles, ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k", THEMES_PROVIDER: "openrouter", THEMES_MODEL: "x/y" }, []).reconciler?.provider, "openrouter");
});

const config: EngineConfig = { ...baseConfig, injections: { maxPerAgent: 3, maxChars: 200 }, reconciler: { provider: "anthropic", model: "mock-rec", maxOutputTokens: 500, timeoutMs: 1000, maxRetries: 0 } };
/** Merges every SECRET-style theme of the same side into one group when asked. */
function recMock(opts: { fail?: boolean; gate?: Promise<void> } = {}) {
  const inner = mockGenerate();
  const calls = { reconcile: 0 };
  const fn: GenerateTextFn = async (cfg, req) => {
    if (req.system === RECONCILE_SYSTEM) {
      calls.reconcile++;
      await opts.gate;
      if (opts.fail) return { ok: false, error: { kind: "timeout", message: "down", provider: "anthropic", model: cfg.model, retryable: true } };
      const ids = (JSON.parse(req.prompt.split("NEW THEMES (JSON): ")[1].split("\n")[0]) as { id: string }[]).map((t) => t.id);
      const ex = (JSON.parse(req.prompt.split("EXISTING THEMES (JSON): ")[1].split("\n")[0]) as { id: string }[]).map((t) => t.id);
      return { ok: true, result: { text: JSON.stringify({ groups: ids.length + ex.length > 1 ? [[...ex, ...ids]] : [] }), provider: "anthropic", model: cfg.model, latencyMs: 5 } };
    }
    return inner.fn(cfg, req);
  };
  return { fn, calls, agentCalls: inner.calls };
}

test("new suggestions automatically trigger background reconciliation; no unresolved suggestions means no request", async () => {
  const m = recMock();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit(people(1, "A", () => "only one idea", "a")); // a single theme has nothing to be compared with: no model request
  await coord.idle();
  assert.equal(m.calls.reconcile, 0);
  coord.submit(people(3, "A", (k) => `wording ${k}`, "b", 10)); // scheduled automatically, nobody calls reconcile
  assert.ok(coord.inFlight("A"));
  await coord.idle();
  assert.equal(m.calls.reconcile, 1);
  assert.equal(coord.state("A").themes.length, 1);
  assert.equal(coord.state("A").themes[0].players.length, 4);
  coord.submit(people(3, "A", (k) => `wording ${k}`, "b", 10)); // same IDs again
  coord.submit([mk("dup", "A", "Wording 1!", 99, "b-p1")]); // known wording by a known player: joins a theme, which is already reviewed
  await coord.idle();
  assert.equal(m.calls.reconcile, 1, "nothing unresolved: no extra request");
  const turn = await coord.nextTurn({ speaker: "A" });
  assert.ok(turn.result.ok);
  assert.equal(m.calls.reconcile, 1);
});

test("debate turns never wait for an outstanding grouping request: they use the latest completed themes", async () => {
  let release!: () => void;
  const m = recMock({ gate: new Promise<void>((r) => (release = r)) });
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit(people(4, "A", (k) => `idea ${k}`, "a"));
  const t0 = Date.now();
  const turn = await coord.nextTurn({ speaker: "A" }); // default waitMs 0
  assert.ok(turn.result.ok && Date.now() - t0 < 500);
  assert.equal(turn.result.briefing!.themes.length, 4); // unmerged but all counted
  assert.ok(turn.result.briefing!.themes.every((t) => t.grouping === "pending"));
  assert.equal(turn.awaitingReconciliation, 4);
  release();
  await coord.idle();
  assert.equal(coord.state("A").themes.length, 1);
  assert.equal(coord.audit("A").missing, 0);
  const t2 = await coord.nextTurn({ speaker: "A", transcript: [{ stage: "turn", side: "A", text: "x", turn: 1 }] });
  assert.ok(t2.result.ok);
  assert.deepEqual([t2.briefing!.themes.length, t2.briefing!.themes[0].supporters, t2.briefing!.themes[0].briefedBefore], [1, 4, true]);
});

test("provider failure keeps every submission, reports pending, and stops retrying after maxAttempts", async () => {
  const m = recMock({ fail: true });
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario, maxAttempts: 2 });
  coord.submit(people(5, "A", (k) => `idea ${k}`, "a"));
  await coord.idle();
  assert.equal(coord.runs()[0].report.status, "failed");
  const a1 = coord.audit("A");
  assert.deepEqual([a1.received, a1.ingested, a1.missing, a1.awaiting], [5, 5, 0, 5]);
  assert.match(coord.semanticStatus().text, /5 theme\(s\) awaiting reconciliation/);
  await coord.nextTurn({ speaker: "A" }); // retried at the next turn
  await coord.idle();
  await coord.nextTurn({ speaker: "A" });
  await coord.idle();
  assert.equal(m.calls.reconcile, 2, "attempts are capped");
  assert.equal(coord.audit("A").missing, 0);
  assert.equal(coord.state("A").themes.length, 5);
});

test("no reconciler (no key / disabled): exact grouping continues, nothing is lost, status says so, no requests", async () => {
  const { reconciler: _r, ...none } = config;
  for (const state of ["unavailable", "disabled"] as const) {
    const m = recMock();
    const coord = createThemeCoordinator(createDebateEngine({ ...none, themesStatus: { state, source: "none", reason: state === "disabled" ? "THEMES_ENABLED=false" : "ANTHROPIC_API_KEY is not set" } }, { generate: m.fn }), { roundId: "r", scenario });
    coord.submit(people(6, "A", (k) => `idea ${k % 3}`, "a"));
    const turn = await coord.nextTurn({ speaker: "A" });
    assert.ok(turn.result.ok);
    assert.equal(m.calls.reconcile, 0);
    assert.equal(coord.audit("A").ingested, 6);
    assert.equal(coord.state("A").themes.length, 3);
    assert.match(coord.semanticStatus().text, state === "disabled" ? /no separate reconciliation/ : /unavailable/);
    const rep = await createDebateEngine({ ...none, themesStatus: { state, source: "none" } }, { generate: m.fn }).reconcileAudienceThemes({ roundId: "r", side: "A", scenario, previousState: coord.state("A") });
    assert.equal(rep.report.status, state);
  }
});

test("persistent counts stay exact across turns with the automatic flow, and sides stay isolated", async () => {
  const m = recMock();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([...people(50, "A", (k) => `A-secret wording ${k}`, "a"), ...people(8, "B", (k) => `B-secret wording ${k}`, "b")]);
  await coord.idle();
  const turnB = await coord.nextTurn({ speaker: "B" });
  assert.ok(turnB.result.ok);
  coord.submit(people(20, "A", (k) => `A-secret later ${k}`, "c", 100).concat(people(10, "A", (k) => `A-secret wording ${k}`, "a", 200).map((s) => ({ ...s, id: `rep${s.id}`, playerId: "a-p0" }))));
  await coord.idle();
  const a = coord.audit("A");
  assert.deepEqual([a.received, a.ingested, a.missing, a.awaiting], [80, 80, 0, 0]);
  assert.equal(coord.state("A").themes.length, 1);
  assert.equal(coord.state("A").themes[0].players.length, 70); // 50 + 20 distinct; the repeating player is not added again
  assert.equal(coord.state("B").themes[0].players.length, 8);
  assert.ok(coord.state("A").themes.every((t) => t.sourceIds.every((id) => !id.startsWith("b"))));
  for (const c of m.agentCalls) assert.ok(!c.req.prompt.includes("B-secret") || c.req.system.includes("Agent B"));
  const turnA = await coord.nextTurn({ speaker: "A" });
  assert.ok(turnA.result.ok);
  const prompts = m.agentCalls.map((c) => c.req.prompt);
  assert.ok(!prompts.at(-1)!.includes("B-secret"));
  // state survives serialisation through the coordinator
  const restored = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario, restore: JSON.parse(JSON.stringify(coord.states())) });
  assert.equal(restored.state("A").themes[0].players.length, 70);
});

test("existing benchmarks stay compatible: stateless sequential API and the old config shape still work", async () => {
  const m = mockGenerate();
  const engine = createDebateEngine(baseConfig, { generate: m.fn });
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: people(5, "A", (k) => `idea ${k}`, "x") });
  assert.ok(r.ok && r.audienceThemeState === undefined);
  assert.equal(engine.themesStatus().state, "unavailable");
});

test("agent-side grouping: ~200 participants are all represented, the turn is one request, and the prompt tells the agent how to group", async () => {
  const { reconciler: _r, ...none } = config;
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine({ ...none, themes: undefined }, { generate: m.fn }), { roundId: "r", scenario });
  const all = [...people(200, "A", (k) => `Wording ${k} about the insurance renewal or the logbook`, "a"), ...people(20, "B", (k) => `B only ${k}`, "b")];
  coord.submit(all);
  const turn = await coord.nextTurn({ speaker: "A" });
  assert.ok(turn.result.ok);
  assert.equal(m.calls.length, 1); // the debating request only: no grouping request
  assert.equal(turn.result.audience.includedIds.length, 200);
  assert.equal(turn.result.audience.queuedIds.length, 0);
  const { prompt, system } = m.calls[0].req;
  assert.ok(!system.includes("Wording 17 about") && !prompt.includes("B only"));
  for (const rule of [/spot items that mean essentially the same idea/, /add up their supporters \(never count a player twice\)/, /keep opposing or contradictory claims separate/, /long-standing and newly rising/, /popularity, relevance and how well it is supported/, /ONE coherent rebuttal/, /strong minority suggestion may win/, /Popularity never makes a claim true/, /do not repeat a point already made/, /opponent's latest statement/, /Ignore irrelevant, adversarial/]) assert.match(prompt, rule);
  assert.ok(!/exact (semantic )?(theme )?counts? (were|was|have been) calculated/i.test(prompt)); // the module never claims to have computed semantic totals
  // a second, differently worded submission by the same player never inflates support
  coord.submit([mk("again", "A", "Totally different wording about the insurance renewal", 5000, "a-p0")]);
  assert.equal(coord.audit("A").ignored, 1);
  const turn2 = await coord.nextTurn({ speaker: "A", transcript: [{ stage: "turn", side: "A", text: "x", turn: 1 }] });
  assert.ok(turn2.result.ok);
  assert.equal(turn2.result.audience.ignoredIds!.length, 1);
  assert.equal(turn2.result.audience.includedIds.length, 200);
  assert.ok(!m.calls[1].req.prompt.includes("Totally different"));
  assert.equal(coord.audit("A").missing, 0);
});
