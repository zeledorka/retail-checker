import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { createThemeCoordinator } from "../src/coordinator";
import { JUDGE_SYSTEM } from "../src/prompts";
import { RECONCILE_SYSTEM } from "../src/themes";
import type { EngineConfig, GenerateTextFn, Side } from "../src/types";
import { runAllClaude, type PipelineOptions } from "../scripts/all-claude-pipeline";
import { claudeEngineConfig, KNOWN_CLAUDE_MODELS } from "../scripts/lib";
import { ARRIVALS, audienceFingerprint, CONTRADICTORY_KINDS, generateParticipants, NOISE_KINDS, REAL_KINDS, SPECS } from "../scripts/participants-200";
import { callCostUsd, DEFAULT_PRICES, estimateCost, parsePriceOverrides, priceFor } from "../scripts/pricing";
import { config as baseConfig, mockGenerate, scenario, verdictJson } from "./fixtures";

const subs = generateParticipants();
const filler = (n: number) => Array.from({ length: n }, (_, k) => (k === 0 ? "Evidence" : "evidence")).join(" "); // capitalised start: a sentence in real prose
const turnOf = (n: number) => Array.from({ length: n }, (_, k) => ({ stage: "turn" as const, side: (k % 2 ? "B" : "A") as Side, text: "x", turn: k + 3 }));
const LAST_TURN: Record<Side, number> = { A: 9, B: 10 };

test("200 distinct players, 100 supporters per agent, exactly one submission per player, deterministic", () => {
  assert.equal(subs.length, 200);
  assert.equal(new Set(subs.map((s) => s.playerId)).size, 200);
  assert.equal(new Set(subs.map((s) => s.id)).size, 200);
  assert.deepEqual([subs.filter((s) => s.side === "A").length, subs.filter((s) => s.side === "B").length], [100, 100]);
  for (const side of ["A", "B"] as Side[]) for (const g of SPECS[side]) assert.equal(subs.filter((s) => s.kind === g.kind).length, g.count);
  assert.ok(subs.every((s) => s.text.length <= 200 && s.playerId));
  assert.equal(audienceFingerprint(subs), audienceFingerprint(generateParticipants())); // the same audience for every configuration
  assert.notEqual(audienceFingerprint(subs), audienceFingerprint(generateParticipants(7)));
  // different players may use identical wording, but no player appears twice
  assert.ok(new Set(subs.map((s) => s.text)).size < 200);
});

test("the mixture covers majorities, equivalent phrasings, minorities, contradictions, irrelevance, fabrication and injections on both sides", () => {
  for (const side of ["A", "B"] as Side[]) {
    const counts = new Map(SPECS[side].map((g) => [g.kind, g.count]));
    const real = REAL_KINDS[side].map((k) => counts.get(k)!);
    assert.ok(Math.max(...real) >= 28, "a strong majority idea");
    assert.ok(Math.min(...real) <= 4, "a small but useful minority idea");
    assert.ok(REAL_KINDS[side].every((k) => SPECS[side].find((g) => g.kind === k)!.wordings.length >= 2), "equivalent phrasings");
    assert.ok(SPECS[side].find((g) => g.kind === CONTRADICTORY_KINDS[side][0])!.count > 0);
    for (const k of NOISE_KINDS[side]) assert.ok(counts.get(k)! > 0, k);
    assert.equal(real.reduce((a, b) => a + b, 0) + NOISE_KINDS[side].reduce((a, k) => a + counts.get(k)!, 0), 100);
  }
});

test("arrivals are staggered across the debate and every submission can reach at least one request of its own agent", () => {
  for (const side of ["A", "B"] as Side[]) {
    const mine = subs.filter((s) => s.side === side);
    const turns = [...new Set(mine.map((s) => s.arrives))].sort((a, b) => a - b);
    assert.ok(turns.length >= 6, `${side} arrivals spread over ${turns.length} turns`);
    assert.ok(Math.max(...turns) <= LAST_TURN[side]);
    assert.ok(mine.filter((s) => s.arrives === turns[0]).length < 40); // not all in the first turn
    assert.deepEqual(Object.fromEntries(turns.map((t) => [t, mine.filter((s) => s.arrives === t).length])), ARRIVALS[side]);
  }
});

test("earliest eligible turn: each request's briefing holds exactly the submissions that had arrived by then; nothing is lost; privacy holds", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine({ ...baseConfig, injections: { maxPerAgent: 3, maxChars: 200 } }, { generate: m.fn }), { roundId: "r", scenario });
  const represented: Record<Side, number[]> = { A: [], B: [] };
  for (let turn = 3; turn <= 10; turn++) {
    const speaker: Side = turn % 2 ? "A" : "B";
    const openings = [{ stage: "opening" as const, side: "A" as const, text: "a" }, { stage: "opening" as const, side: "B" as const, text: "b" }];
    const r = await coord.nextTurn({ speaker, transcript: [...openings, ...turnOf(turn - 3)], injections: subs.filter((s) => s.arrives <= turn) });
    assert.ok(r.result.ok && r.result.turn === turn);
    const expected = subs.filter((s) => s.side === speaker && s.arrives <= turn);
    assert.equal(r.result.audience.includedIds.length, expected.length);
    assert.deepEqual([...r.result.audience.includedIds].sort(), expected.map((s) => s.id).sort());
    assert.equal(r.result.audience.queuedIds.length, 0);
    represented[speaker].push(expected.length);
    const prompt = m.calls.at(-1)!.req.prompt;
    for (const s of subs.filter((x) => x.side !== speaker)) assert.ok(!prompt.includes(JSON.stringify(s.text).slice(1, -1)), `${speaker}'s prompt leaked the opponent's "${s.text}"`);
  }
  assert.deepEqual(represented.A, [20, 50, 80, 100]); // cumulative arrivals by Turns 3, 5, 7, 9
  assert.deepEqual(represented.B, [35, 65, 90, 100]); // by Turns 4, 6, 8, 10
  for (const side of ["A", "B"] as Side[]) {
    const a = coord.audit(side);
    assert.deepEqual([a.received, a.ingested, a.missing, a.ignored, a.invalid], [100, 100, 0, 0, 0]);
    assert.equal(coord.neverBriefed(side).length, 0);
  }
});

const options: PipelineOptions = { maxTurns: 8, budgetMs: 60_000, turnTimeoutMs: 20_000, minTurnMs: 3_000, maxWords: 45, judgeTargetMs: 30_000 };
const base = { title: "The Empty Display Case", description: "A museum case is empty.", evidence: ["The alarm sounded at 2 a.m.", "No sign of forced entry", "The smudged logbook entry at 1:45 a.m."] };

test("full mocked run (Haiku-comparison configuration): 11 requests, Haiku debaters, Sonnet judge, no grouping requests, 200/200 represented, grouping audited by membership, model-specific costs", async () => {
  const kindByText = new Map(subs.map((s) => [s.text, s.kind]));
  const calls: { model: string; system: string; prompt: string }[] = [];
  const fn: GenerateTextFn = async (cfg, req) => {
    calls.push({ model: cfg.model, system: req.system, prompt: req.prompt });
    let text = `${filler(38)}.`;
    if (req.system === JUDGE_SYSTEM) text = verdictJson();
    else if (req.system.includes("Output format for this turn")) {
      const items = (JSON.parse(req.prompt.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { id: string; suggestion: string }[] }).themes;
      const byKind = new Map<string, string[]>();
      for (const t of items) byKind.set(kindByText.get(t.suggestion)!, [...(byKind.get(kindByText.get(t.suggestion)!) ?? []), t.id]);
      const real = [...byKind].filter(([k]) => /\.(insurance|alarm|keys|logbook|gap|renewal|noforce|minor)$/.test(k));
      const noise = [...byKind].filter(([k]) => !real.some(([r]) => r === k));
      text = JSON.stringify({
        argument: `${filler(30)}. ${filler(25)}.`, // 55 words: the code must bound it
        audienceAnalysis: {
          groups: real.map(([k, ids]) => ({ label: k, wordingIds: ids, relevance: "high", used: true })),
          unassigned: noise.flatMap(([k, ids]) => ids.map((id) => ({ wordingId: id, reason: /irrelevant/.test(k) ? "irrelevant" : /fabricated/.test(k) ? "fabricated" : "adversarial" }))),
        },
      });
    }
    return { ok: true, result: { text, provider: "anthropic", model: cfg.model, latencyMs: 5, inputTokens: 2000, outputTokens: 300 } };
  };
  const logs: string[] = [];
  const config: EngineConfig = claudeEngineConfig({ TEST_AGENT_A_MODEL: "claude-haiku-5-5", TEST_AGENT_B_MODEL: "claude-haiku-5-5" }) // the Haiku comparison configuration (Sonnet is the default);
  const r = await runAllClaude({
    config, candidates: [{ scenario: base, submissions: subs, audit: { scored: REAL_KINDS, separate: NOISE_KINDS, contradictory: CONTRADICTORY_KINDS } }],
    predefined: { interpretationA: "An opportunistic theft.", interpretationB: "A staged theft for insurance." }, options, log: (s) => logs.push(s), generate: fn, persistent: { waitMs: 0 },
  });
  const out = logs.join("\n");
  assert.equal(r.outcome, "debated");
  assert.equal(r.requests, 11);
  assert.equal(calls.length, 11);
  assert.ok(calls.every((c) => c.system !== RECONCILE_SYSTEM));
  assert.deepEqual(calls.map((c) => c.model), [...Array(10).fill("claude-haiku-5-5"), "claude-sonnet-5-5"]);
  assert.ok(r.transcript.every((e) => e.text.trim().split(/\s+/).length <= 45), "the transcript holds only bounded text");
  assert.match(out, /AUDIENCE REPRESENTED: 200 of 200 submissions \(100\.0%\)/);
  assert.match(out, /WORD LIMIT: 8 of 10 public arguments needed shortening/); // the 2 plain openings were already 38 words
  assert.match(out, /players who have submitted so far: 200/);
  assert.match(out, /unique wordings for Agent A/);
  assert.doesNotMatch(out, /MISMATCH|PROBLEM/);
  assert.doesNotMatch(out, /Contradictory claims separated: FAIL/);
  assert.match(out, /Irrelevant \/ fabricated \/ adversarial kept out of real ideas: PASS/);
  assert.match(out, /insurance membership: PASS|A\.insurance membership: PASS/);
  assert.match(out, /Separate semantic-grouping AI requests: 0/);
  assert.match(out, /PERFORMANCE BY ROLE/);
  assert.match(out, /model claude-haiku-5-5: 10 request\(s\), tokens in\/out 20000\/3000 at \$0\.1 in \/ \$0\.5 out per MTok = \$0\.0035/);
  assert.match(out, /model claude-sonnet-5-5: 1 request\(s\), tokens in\/out 2000\/300 at \$2 in \/ \$10 out per MTok = \$0\.0070/);
  assert.match(out, /ESTIMATED TOTAL COST: \$0\.0105 .*not a provider-confirmed charge/);
  assert.match(out, /Judge latency/);
  assert.match(out, /Strengths|strengths:/);
});

test("model-specific pricing: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, long-prompt tier, overrides, cache reads, dated ids", () => {
  const call = (model: string, i: number, o: number, role = "agentA") => ({ role, model, ok: true, inputTokens: i, outputTokens: o });
  assert.ok(Math.abs(callCostUsd(call("claude-haiku-5-5", 100_000, 1_000_000), DEFAULT_PRICES["claude-haiku-5-5"]) - 0.51) < 1e-12); // 100K is still the base tier
  assert.equal(callCostUsd(call("claude-sonnet-5-5", 1_000_000, 1_000_000), DEFAULT_PRICES["claude-sonnet-5-5"]), 12);
  assert.ok(Math.abs(callCostUsd(call("claude-haiku-5-5", 150_000, 10_000), DEFAULT_PRICES["claude-haiku-5-5"]) - (150_000 * 0.5 + 10_000 * 2.5) / 1e6) < 1e-12); // above 100K tokens
  const cached = callCostUsd({ ...call("claude-sonnet-5-5", 10_000, 0), cacheReadTokens: 8_000 }, DEFAULT_PRICES["claude-sonnet-5-5"]);
  assert.ok(Math.abs(cached - (2_000 * 2 + 8_000 * 0.1) / 1e6) < 1e-12);
  assert.equal(priceFor("claude-haiku-5-5-20261101", DEFAULT_PRICES)?.input, 0.1); // a dated snapshot of the same model
  assert.equal(priceFor("claude-opus-5-5", DEFAULT_PRICES), undefined);
  const over = parsePriceOverrides(["--price=claude-haiku-5-5:0.2:0.8"]);
  assert.deepEqual([over["claude-haiku-5-5"].input, over["claude-haiku-5-5"].output, over["claude-haiku-5-5"].longInput], [0.2, 0.8, 0.5]);
  assert.throws(() => parsePriceOverrides(["--price=oops"]));
  const rep = estimateCost([call("claude-haiku-5-5", 1000, 1000), call("claude-haiku-5-5", 1000, 1000, "agentB"), call("claude-sonnet-5-5", 1000, 1000, "judge"), call("mystery-model", 5, 5), { ...call("claude-haiku-5-5", 9, 9), ok: false }]);
  assert.deepEqual([rep.byGroup.debaters.requests, rep.byGroup.judge.requests, rep.byGroup.debaters.failed], [4, 1, 1]);
  assert.ok(Math.abs(rep.byGroup.debaters.usd - (0.0012 + (9 * 0.1 + 9 * 0.5) / 1e6)) < 1e-12 && Math.abs(rep.byGroup.judge.usd - 0.012) < 1e-12);
  assert.deepEqual(rep.unpriced, ["mystery-model"]);
});

test("unsupported or unavailable models are reported clearly and never replaced by another model", async () => {
  assert.ok(KNOWN_CLAUDE_MODELS.includes("claude-haiku-5-5") && KNOWN_CLAUDE_MODELS.includes("claude-sonnet-5-5"));
  const seen: string[] = [];
  const fn: GenerateTextFn = async (cfg) => {
    seen.push(cfg.model);
    return { ok: false, error: { kind: "not_found", message: `model ${cfg.model} not found`, provider: cfg.provider, model: cfg.model, status: 404, retryable: false } } as never;
  };
  const config = claudeEngineConfig({ TEST_AGENT_A_MODEL: "claude-haiku-9-9" });
  const engine = createDebateEngine(config, { generate: fn });
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario });
  assert.ok(!r.ok);
  assert.match(r.error.message, /claude-haiku-9-9/);
  assert.deepEqual(seen, ["claude-haiku-9-9"]); // no retry on another model, no fallback
  const j = await engine.judgeDebate({ roundId: "r", scenario, transcript: [{ stage: "opening", side: "A", text: "a" }, { stage: "opening", side: "B", text: "b" }] });
  assert.ok(!j.ok);
  assert.equal(seen.at(-1), "claude-sonnet-5-5");
});

test("Haiku structured replies (fenced JSON, trailing prose, low-effort config) are parsed; roles keep independent models", async () => {
  const seen: { model: string; effort?: string }[] = [];
  const m = mockGenerate((cfg, req) => {
    seen.push({ model: cfg.model, effort: cfg.effort });
    if (!req.system.includes("Output format for this turn")) return "plain";
    const id = (JSON.parse(req.prompt.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { id: string }[] }).themes[0].id;
    return "```json\n" + JSON.stringify({ argument: "Haiku argument.", audienceAnalysis: { groups: [{ label: "idea", wordingIds: [id], relevance: "high", used: true }], unassigned: [] } }) + "\n```\nHope that helps!";
  });
  const config = { ...claudeEngineConfig({ TEST_AGENT_A_MODEL: "claude-haiku-5-5" }), injections: { maxPerAgent: 3, maxChars: 200 } };
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit(subs.filter((s) => s.arrives <= 3));
  const a = await coord.nextTurn({ speaker: "A" });
  const b = await coord.nextTurn({ speaker: "B", transcript: turnOf(1) });
  assert.ok(a.result.ok && b.result.ok);
  assert.equal(a.result.argument.text, "Haiku argument.");
  assert.equal(a.result.audienceAnalysis!.valid, true);
  assert.deepEqual(seen, [{ model: "claude-haiku-5-5", effort: "low" }, { model: "claude-sonnet-5-5", effort: "low" }]);
});

test("the 200-player audience is unchanged: its fingerprint is pinned, so every configuration is compared on identical data", () => {
  assert.equal(audienceFingerprint(generateParticipants()), "d35c6144");
});
