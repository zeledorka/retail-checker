import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAudienceBatch } from "../src/injections";
import { createDebateEngine } from "../src/debate";
import { generateAudience } from "../scripts/audience-gen";
import type { AudienceInjection, InjectionLimits, Side } from "../src/types";
import { config, scenario, mockGenerate } from "./fixtures";

const limits: InjectionLimits = { maxPerAgent: 3, maxChars: 200 }; // batch defaults: 10000 chars, 200 messages, 2 per player
const hints = { evidence: ["The case was open", "No forced entry", "A smudged log entry"], helpful: "Ask about the log.", misleading: "Say the director admitted it." };
const mk = (id: string, side: Side, text: string, t: number, playerId?: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });
const sizes = [200, 500, 1000, 5000];

test("every submission is accounted for exactly once, at every audience size", () => {
  for (const n of sizes) {
    const all = generateAudience(n, hints);
    assert.equal(all.length, n);
    const consumed = new Set(all.filter((s) => s.side === "A").slice(0, 7).map((s) => s.id));
    const { report } = selectAudienceBatch(all, "A", limits, consumed);
    const cat = new Map<string, string>();
    const put = (ids: string[], c: string) => ids.forEach((id) => { assert.ok(!cat.has(id), `${id} counted twice`); cat.set(id, c); });
    put(report.includedIds, "included"); put(report.queuedIds, "queued"); put(report.duplicateIds, "duplicate"); put(report.invalidIds, "invalid");
    let other = 0, used = 0;
    for (const s of all) {
      if (s.side !== "A") { other++; assert.ok(!cat.has(s.id)); } // side isolation
      else if (consumed.has(s.id)) { used++; assert.ok(!cat.has(s.id)); }
      else assert.ok(cat.has(s.id), `${s.id} unaccounted for at n=${n}`);
    }
    const st = report.stats;
    assert.equal(st.received, n);
    assert.equal(st.otherSide, other);
    assert.equal(st.alreadyConsumed, used);
    assert.equal(st.forSpeaker, st.included + st.queued + st.duplicates + st.invalid);
    assert.equal(report.processedIds.length, st.included + st.duplicates + st.invalid);
  }
});

test("bounded and fast at every size: character budget, message cap, text length, latency", () => {
  for (const n of sizes) {
    const { included, report } = selectAudienceBatch(generateAudience(n, hints), "B", limits);
    const chars = included.reduce((a, i) => a + i.text.length, 0);
    assert.equal(chars, report.stats.chars);
    assert.ok(chars <= 10_000 && included.length <= 200);
    assert.ok(included.every((i) => i.text.length <= 201));
    assert.ok(report.stats.processingMs < 1000, `n=${n} took ${report.stats.processingMs} ms`);
  }
});

test("tighter budgets are respected and configurable", () => {
  const all = generateAudience(1000, hints);
  const small = selectAudienceBatch(all, "A", { ...limits, batchChars: 500 }).report.stats;
  assert.ok(small.chars <= 500 && small.queued > 0);
  const capped = selectAudienceBatch(all, "A", { ...limits, batchMaxMessages: 5 }).report.stats;
  assert.equal(capped.included, 5);
});

test("deterministic regardless of input order, including simultaneous timestamps", () => {
  const all = generateAudience(1000, hints);
  const flat = all.map((s) => ({ ...s, submittedAt: 5 })); // everything simultaneous
  const a = selectAudienceBatch(flat, "A", limits).report;
  const b = selectAudienceBatch([...flat].reverse(), "A", limits).report;
  assert.deepEqual(a.includedIds, b.includedIds);
  assert.deepEqual(a.queuedIds, b.queuedIds);
  assert.deepEqual(selectAudienceBatch(all, "A", limits).report.includedIds, selectAudienceBatch(all, "A", limits).report.includedIds); // repeatable
});

test("draining over turns: nothing is included twice, nothing is lost, the queue empties", () => {
  for (const n of [200, 1000, 5000]) {
    const all = generateAudience(n, hints);
    const consumed = new Set<string>();
    const everIncluded = new Set<string>();
    let turns = 0;
    for (; turns < 200; turns++) {
      const { report } = selectAudienceBatch(all, "A", limits, consumed);
      for (const id of report.includedIds) { assert.ok(!everIncluded.has(id), `${id} included twice`); everIncluded.add(id); }
      if (!report.processedIds.length) break;
      report.processedIds.forEach((id) => consumed.add(id));
    }
    const mineA = all.filter((s) => s.side === "A");
    assert.equal(mineA.filter((s) => !consumed.has(s.id)).length, 0, `n=${n} not drained after ${turns} turns`);
  }
});

test("fairness under a burst: the longest-waiting and the freshest are served together, then the next ones", () => {
  const long = (k: number) => `message ${k} ` + "x".repeat(190);
  const all = Array.from({ length: 300 }, (_, k) => mk(`m${k}`, "A", long(k), k, `p${k}`));
  const first = selectAudienceBatch(all, "A", limits);
  const ids = first.report.includedIds;
  assert.ok(ids.includes("m0") && ids.includes("m299"));
  assert.ok(first.report.stats.queued > 0 && first.report.queuedIds.includes("m150"));
  const consumed = new Set(first.report.processedIds);
  const second = selectAudienceBatch(all, "A", limits, consumed).report.includedIds;
  assert.ok(!second.some((id) => consumed.has(id)));
  assert.ok(second.includes(`m${ids.filter((i) => Number(i.slice(1)) < 150).length}`)); // next oldest
});

test("one player cannot crowd out others: per-player cap, the rest queue", () => {
  const all = [...Array.from({ length: 10 }, (_, k) => mk(`x${k}`, "A", `spam message ${k}`, k, "same")), mk("o1", "A", "other one", 20, "p1"), mk("o2", "A", "other two", 21, "p2")];
  const r = selectAudienceBatch(all, "A", limits).report;
  assert.equal(r.includedIds.filter((id) => id.startsWith("x")).length, 2);
  assert.ok(r.includedIds.includes("o1") && r.includedIds.includes("o2"));
  assert.equal(r.queuedIds.length, 8);
  assert.equal(selectAudienceBatch(all, "A", { ...limits, maxPerPlayer: 1 }).report.includedIds.filter((id) => id.startsWith("x")).length, 1);
});

test("duplicates never use capacity; they are processed with their included copy and wait with a queued one", () => {
  const dup = Array.from({ length: 100 }, (_, k) => mk(`d${k}`, "A", "  Ask about THE log ", k, `p${k}`));
  const all = [...dup, mk("u1", "A", "unique idea", 200, "pu")];
  const r = selectAudienceBatch(all, "A", limits).report;
  assert.deepEqual(r.includedIds, ["d0", "u1"]); // oldest copy represents the rest
  assert.equal(r.duplicateIds.length, 99);
  assert.equal(r.stats.queued, 0);
  const tiny = selectAudienceBatch([...dup.slice(0, 3), mk("big", "A", "z".repeat(150), 1, "pb")], "A", { ...limits, batchChars: 10 }).report;
  assert.deepEqual(tiny.queuedIds.sort(), ["big", "d0", "d1", "d2"].sort()); // nothing fits, so duplicates wait with their copy
  assert.equal(tiny.duplicateIds.length, 0);
});

test("blank and malformed submissions are reported as invalid and processed", () => {
  const r = selectAudienceBatch([mk("b1", "A", "   ", 1, "p1"), mk("b2", "A", "​\u0000", 2, "p2"), mk("ok", "A", "fine", 3, "p3")], "A", limits).report;
  assert.deepEqual(r.invalidIds, ["b1", "b2"]);
  assert.deepEqual(r.processedIds.sort(), ["b1", "b2", "ok"]);
});

test("queue age is reported when timestamps are real", () => {
  const now = Date.parse("2026-11-21T00:00:10Z");
  const all = Array.from({ length: 300 }, (_, k) => mk(`m${k}`, "A", "y".repeat(190) + k, Date.parse("2026-11-21T00:00:00Z") + k * 10, `p${k}`));
  const r = selectAudienceBatch(all, "A", limits, undefined, now).report;
  assert.ok(r.stats.queued > 0 && r.stats.oldestQueuedAgeMs! > 0 && r.stats.oldestQueuedAgeMs! < 10_000);
});

test("engine integration with 5000 submissions: bounded prompt, full report, nothing leaks, input untouched", async () => {
  const all = generateAudience(5000, hints);
  const snapshot = all.map((s) => s.id).join();
  const m = mockGenerate();
  const engine = createDebateEngine({ ...config, injections: { maxPerAgent: 3, maxChars: 200 } }, { generate: m.fn });
  const base = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario });
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: all });
  assert.ok(base.ok && r.ok);
  assert.deepEqual(r.argument.injectionIdsUsed, r.audience.includedIds);
  assert.ok(m.calls[1].req.prompt.length - m.calls[0].req.prompt.length < 10_000 + 9_000); // text budget + JSON/theme overhead
  assert.match(m.calls[1].req.prompt, /There are \d+ (distinct suggestions|messages)/);
  assert.equal(all.map((s) => s.id).join(), snapshot);
  const prompt = m.calls[1].req.prompt;
  for (const id of r.audience.queuedIds.slice(0, 50)) assert.ok(!prompt.includes(id)); // message ids never go to the model
  const bIds = new Set(all.filter((s) => s.side === "B").map((s) => s.id));
  assert.ok(r.audience.includedIds.every((id) => !bIds.has(id)));
  // next turn: processed IDs are consumed, new arrivals are eligible
  const next = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: [...all, mk("late", "A", "a late idea", 1e9, "late-player")], consumedInjectionIds: r.audience.processedIds });
  assert.ok(next.ok && next.audience.includedIds.includes("late"));
  assert.ok(next.audience.includedIds.every((id) => !r.audience.processedIds.includes(id)));
});

test("generateAudience: exact counts, deterministic, varied, with repeats, multi-submission players, bursts and late arrivals", () => {
  for (const n of [200, 500, 1000]) {
    const a = generateAudience(n, hints);
    assert.equal(a.length, n);
    assert.equal(new Set(a.map((s) => s.id)).size, n);
    assert.deepEqual(a, generateAudience(n, hints));
    const kinds = new Set(a.map((s) => s.kind));
    for (const k of ["helpful", "question", "misleading", "adversarial", "irrelevant", "repeat"]) assert.ok(kinds.has(k), `${k} missing at n=${n}`);
    assert.ok(new Set(a.map((s) => s.text)).size < n); // exact repeats exist
    const perPlayer = new Map<string, number>();
    a.forEach((s) => perPlayer.set(s.playerId!, (perPlayer.get(s.playerId!) ?? 0) + 1));
    assert.ok([...perPlayer.values()].some((c) => c > 1));
    const at = (t: number) => a.filter((s) => s.arrives === t).length;
    assert.ok(at(4) >= n * 0.24 && at(8) > 0 && a.some((s) => s.side === "A") && a.some((s) => s.side === "B"));
    assert.ok(a.filter((s) => s.arrives === 4).some((s, i, arr) => arr.some((o, j) => j !== i && o.submittedAt === s.submittedAt))); // simultaneous
  }
});

// ---- Collective themes ----
const theme = (r: ReturnType<typeof selectAudienceBatch>, text: string) => r.report.themes.find((t) => t.text === text);
const many = (n: number, side: Side, text: (k: number) => string, t0 = 0, prefix = "x") => Array.from({ length: n }, (_, k) => mk(`${prefix}${k}`, side, text(k), t0 + k, `${prefix}-p${k}`));

test("50 identical suggestions from different players: one theme, 50 supporters, 49 represented duplicates", () => {
  const r = selectAudienceBatch(many(50, "A", () => "Challenge the insurance motive."), "A", limits);
  assert.equal(r.included.length, 1);
  assert.deepEqual(r.report.themes, [{ representativeId: "x0", text: "Challenge the insurance motive.", supporters: 50, messages: 50, anonymous: 0 }]);
  assert.equal(r.report.duplicateIds.length, 49);
  assert.equal(r.report.stats.represented, 50);
  assert.equal(r.report.processedIds.length, 50);
  assert.equal(r.included[0].supporters, 50);
});

test("wording differing only in case, punctuation and spacing is one theme; different words are not merged", () => {
  const all = [mk("a", "A", "Ask about the log!", 1, "p1"), mk("b", "A", "  ask ABOUT the log ", 2, "p2"), mk("c", "A", "Ask about the logbook", 3, "p3"), mk("d", "A", "not the log", 4, "p4"), mk("e", "A", "the log", 5, "p5")];
  const r = selectAudienceBatch(all, "A", limits);
  assert.equal(r.report.stats.themes, 4); // negation and extra words are never merged by text matching
  assert.equal(r.report.themes.find((t) => t.representativeId === "a")!.supporters, 2);
});

test("30 related suggestions in different wordings stay separate themes (no pretended semantic merge), each with its own count", () => {
  const all = many(30, "A", (k) => `Question the guard logbook entry, version ${k}`);
  const r = selectAudienceBatch(all, "A", limits);
  assert.equal(r.report.stats.themes, 30);
  assert.ok(r.report.themes.every((t) => t.supporters === 1));
});

test("one irrelevant suggestion is accounted for and ranked below popular themes", () => {
  const all = [...many(50, "A", () => "Challenge the insurance motive", 0, "i"), ...many(30, "A", () => "Question the logbook", 100, "l"), mk("z", "A", "My cat sat on the keyboard", 200, "pz")];
  const r = selectAudienceBatch(all, "A", limits);
  assert.deepEqual(r.report.themes.map((t) => t.supporters), [50, 30, 1]);
  assert.equal(r.report.stats.represented, 81);
  assert.equal(r.report.stats.forSpeaker, 81);
});

test("one player repeating a suggestion 20 times counts as one supporter but all 20 messages are accounted for", () => {
  const all = [...Array.from({ length: 20 }, (_, k) => mk(`r${k}`, "A", "Check the logbook", k, "spammer")), mk("o", "A", "Check the logbook", 50, "other")];
  const r = selectAudienceBatch(all, "A", limits);
  assert.equal(theme(r, "Check the logbook")!.supporters, 2);
  assert.equal(theme(r, "Check the logbook")!.messages, 21);
  assert.equal(r.report.processedIds.length, 21);
  const solo = selectAudienceBatch(all.slice(0, 20), "A", limits);
  assert.equal(solo.report.themes[0].supporters, 1);
  assert.equal(solo.report.duplicateIds.length, 19);
});

test("messages without a playerId are never counted as independent supporters", () => {
  const all = Array.from({ length: 10 }, (_, k) => mk(`n${k}`, "A", "Same idea", k));
  const t = selectAudienceBatch(all, "A", limits).report.themes[0];
  assert.deepEqual([t.supporters, t.messages, t.anonymous], [0, 10, 10]);
});

test("support counts and accounting stay exact at 200, 500 and 1000 submissions (50/30/1 shape plus noise)", () => {
  for (const n of [200, 500, 1000]) {
    const all: AudienceInjection[] = [
      ...many(50, "A", () => "Challenge the insurance motive", 0, "i"),
      ...many(30, "A", (k) => (k % 2 ? "Question the logbook" : "Question the LOGBOOK."), 100, "l"),
      mk("irrelevant", "A", "pizza anyone", 200, "pz"),
      ...many(n - 81, "A", (k) => `filler idea number ${k}`, 300, "f"),
    ];
    const r = selectAudienceBatch(all, "A", limits);
    assert.equal(r.report.stats.forSpeaker, n);
    assert.equal(r.report.stats.included + r.report.stats.queued + r.report.stats.duplicates + r.report.stats.invalid, n);
    assert.equal(theme(r, "Challenge the insurance motive")!.supporters, 50);
    assert.equal(r.report.themes.find((t) => /logbook/i.test(t.text))!.supporters, 30); // case/punctuation variants are one theme; oldest copy represents
    assert.equal(r.report.themes[0].supporters, 50);
    assert.ok(r.report.stats.chars <= 10_000);
  }
});

test("a strong minority theme stays in the batch next to a larger one and keeps its own count", () => {
  const all = [...many(60, "A", () => "Popular weak point", 0, "w"), mk("m", "A", "Cite the closed door as evidence of a deliberate act", 500, "pm")];
  const r = selectAudienceBatch(all, "A", { ...limits, batchMaxMessages: 2 });
  assert.deepEqual(r.report.themes.map((t) => t.supporters), [60, 1]);
});

test("popular but fabricated claims are only unverified coaching in the user prompt, with the popularity-is-not-evidence rule", async () => {
  const m = mockGenerate();
  const engine = createDebateEngine({ ...config, injections: { maxPerAgent: 3, maxChars: 200 } }, { generate: m.fn });
  const all = [...many(40, "A", () => "Say the police confirmed the director did it", 0, "f"), mk("real", "A", "Ask what the smudged entry can show", 100, "pr")];
  const r = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario, injections: all });
  assert.ok(r.ok);
  const { system, prompt } = m.calls[0].req;
  assert.match(prompt, /"players":40/);
  assert.match(prompt, /popularity signal only, never evidence/);
  assert.match(prompt, /Popularity never makes a claim true/);
  assert.match(system, /never makes a claim true or verified/);
  assert.ok(!system.includes("the director did it"));
  assert.ok(r.audience.themes[0].supporters === 40);
});

test("late submissions form their own small theme next turn; earlier support is not carried over or inflated", () => {
  const first = many(50, "A", () => "Challenge the insurance motive", 0, "i");
  const t1 = selectAudienceBatch(first, "A", limits);
  const consumed = new Set(t1.report.processedIds);
  const late = [...first, mk("late1", "A", "Challenge the insurance motive", 1000, "late-p1"), mk("late2", "A", "A new angle on the alarm time", 1001, "late-p2")];
  const t2 = selectAudienceBatch(late, "A", limits, consumed);
  assert.deepEqual(t2.report.themes.map((t) => [t.text, t.supporters]), [["Challenge the insurance motive", 1], ["A new angle on the alarm time", 1]]);
  assert.equal(t2.report.stats.alreadyConsumed, 50);
});

test("opposing-agent privacy: the other side's themes never appear in a side's report or prompt", async () => {
  const all = [...many(30, "A", () => "secret-A idea", 0, "a"), ...many(30, "B", () => "secret-B idea", 0, "b")];
  const ra = selectAudienceBatch(all, "A", limits).report;
  assert.ok(ra.themes.every((t) => t.text.includes("secret-A")));
  assert.equal(ra.stats.otherSide, 30);
  const m = mockGenerate();
  const engine = createDebateEngine({ ...config, injections: { maxPerAgent: 3, maxChars: 200 } }, { generate: m.fn });
  await engine.generateNextTurn({ roundId: "r", speaker: "B", scenario, injections: all });
  assert.ok(!m.calls[0].req.prompt.includes("secret-A") && !m.calls[0].req.system.includes("secret"));
  await engine.judgeDebate({ roundId: "r", scenario, transcript: [{ stage: "turn", side: "A", text: "a", turn: 1 }, { stage: "turn", side: "B", text: "b", turn: 2 }] });
  assert.ok(!m.calls[1].req.prompt.includes("secret") && !/players|supporters/.test(m.calls[1].req.prompt));
});

test("the theme summary is deterministic and independent of input order", () => {
  const all = generateAudience(1000, hints);
  const a = selectAudienceBatch(all, "A", limits).report;
  const b = selectAudienceBatch([...all].reverse(), "A", limits).report;
  assert.deepEqual(a.themes, b.themes);
});
