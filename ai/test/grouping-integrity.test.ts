import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebateEngine } from "../src/debate";
import { createThemeCoordinator } from "../src/coordinator";
import { validateAudienceAnalysis } from "../src/grouping";
import { buildThemeBriefing, createAudienceThemeState, ingestSubmissions } from "../src/themes";
import { JUDGE_SYSTEM } from "../src/prompts";
import { auditGrouping } from "../scripts/grouping-audit";
import type { AudienceInjection, EngineConfig, Side } from "../src/types";
import { config as baseConfig, mockGenerate, scenario, verdictJson } from "./fixtures";

const config: EngineConfig = { ...baseConfig, injections: { maxPerAgent: 3, maxChars: 200 } };
const mk = (id: string, side: Side, text: string, t: number, playerId: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });

/** A briefing built from labelled groups of distinct players: [kind, count, wording prefix]. */
function world(spec: [string, number][]) {
  const subs: AudienceInjection[] = [];
  const kindOfPlayer = new Map<string, string>();
  for (const [kind, n] of spec)
    for (let k = 0; k < n; k++) {
      const playerId = `${kind}-p${k}`;
      kindOfPlayer.set(playerId, kind);
      subs.push(mk(`${kind}-${k}`, "A", `${kind} wording ${k}`, subs.length, playerId));
    }
  const state = ingestSubmissions(createAudienceThemeState("r", "A"), subs, 200).state;
  const briefing = buildThemeBriefing(state);
  const ids = (kind: string) => state.themes.filter((t) => t.suggestion.startsWith(`${kind} wording`)).map((t) => t.id);
  const analyse = (groups: unknown[], unassigned: unknown = {}) => validateAudienceAnalysis({ groups, unassigned }, undefined, briefing, state, 0);
  const audit = (a: ReturnType<typeof analyse>, scored: string[], separate: string[], contradictory: string[] = ["opposite"]) =>
    auditGrouping({
      analysis: a,
      playersOfWording: new Map(state.themes.map((t) => [t.id, t.players] as const)),
      kindOfPlayer,
      scored,
      mustStaySeparate: separate,
      contradictory,
      visiblePlayers: new Set(state.themes.flatMap((t) => t.players)),
    });
  return { state, briefing, ids, analyse, audit, kindOfPlayer };
}
const grp = (label: string, ids: string[], relevance = "high", used = true) => ({ label, wordingIds: ids.join(" "), relevance, used });

test("a fabricated claim merged into a legitimate group AND marked fabricated is quarantined: 20 genuine + 3 fabricated is never 23", () => {
  const w = world([["renewal", 20], ["fabricated", 3]]);
  const a = w.analyse([grp("Challenge renewal motive", [...w.ids("renewal"), ...w.ids("fabricated")])], { fabricated: w.ids("fabricated").join(" ") });
  assert.equal(a.groups[0].supporters, 20); // not 23
  assert.deepEqual(a.groups[0].quarantinedWordingIds?.sort(), w.ids("fabricated").sort());
  assert.deepEqual([a.accounting.validated.players, a.accounting.quarantined.players, a.accounting.unsafe.players], [20, 3, 0]);
  assert.equal(a.accounting.balanced, true);
  assert.equal(a.quarantined.length, 3);
  assert.ok(a.rejected.some((r) => r.kind === "conflict" && /quarantined, counted nowhere/.test(r.detail)));
  assert.equal(a.clean, false);
});

test("a wording in a group and in unassigned is quarantined, not 'first group wins'; an explicitly fabricated one never supports a theme", () => {
  const w = world([["alarm", 4]]);
  const [first, ...rest] = w.ids("alarm");
  const a = w.analyse([grp("Alarm", [first, ...rest])], { adversarial: first });
  assert.equal(a.outcomes[first], "quarantined");
  assert.deepEqual(a.groups[0].sourceWordingIds, rest);
  assert.equal(a.groups[0].supporters, 3);
});

test("relevant wordings the agent omitted stay visible: outcome 'missing', counted nowhere, listed, and the audit shows where they went", () => {
  const w = world([["alarm", 6], ["insurance", 10]]);
  const omitted = w.ids("alarm").slice(0, 3);
  const a = w.analyse([grp("Alarm", w.ids("alarm").slice(3)), grp("Insurance", w.ids("insurance"))]);
  assert.deepEqual(a.unmentionedWordingIds.sort(), omitted.sort());
  assert.ok(omitted.every((id) => a.outcomes[id] === "missing"));
  assert.deepEqual([a.accounting.missing.wordings, a.accounting.validated.wordings, a.accounting.balanced], [3, 13, true]);
  assert.equal(a.groups[0].supporters, 3);
  const audit = w.audit(a, ["alarm", "insurance"], []);
  assert.deepEqual(audit.missingMembership, [{ kind: "alarm", notGrouped: 3, unassigned: 0, unsafe: 0, quarantined: 0, missing: 3 }]);
  assert.ok(audit.lines.some((l) => /Missing membership.*alarm 3 \[.*not mentioned 3\]/.test(l)));
});

test("relevant wordings set aside as 'unclear' stay accounted for as unassigned (visible, not support)", () => {
  const w = world([["alarm", 5]]);
  const a = w.analyse([grp("Alarm", w.ids("alarm").slice(0, 3))], { unclear: w.ids("alarm").slice(3).join(" ") });
  assert.deepEqual([a.accounting.unassigned.wordings, a.accounting.unassigned.players, a.accounting.validated.players], [2, 2, 3]);
  assert.deepEqual(a.unassigned.map((u) => u.reason), ["unclear", "unclear"]);
});

test("two different tactical ideas merged by the agent are reported by the audit (TypeScript cannot judge the meaning)", () => {
  const w = world([["alarm", 8], ["keys", 6]]);
  const a = w.analyse([grp("Alarm and keys", [...w.ids("alarm"), ...w.ids("keys")])]);
  assert.equal(a.groups[0].supporters, 14); // structurally valid
  const audit = w.audit(a, ["alarm", "keys"], []);
  assert.deepEqual(audit.realIdeasMerged, ["Alarm and keys (alarm x8 + keys x6)"]);
  assert.ok(audit.categories.some((c) => c.verdict === "IMPURE" || c.bestGroup?.foreign));
});

test("a genuine idea split over several groups keeps exact union counts and is reported as a (possibly legitimate) split, not as invalid", () => {
  const w = world([["insurance", 12]]);
  const ids = w.ids("insurance");
  const a = w.analyse([grp("Renewal is routine", ids.slice(0, 5)), grp("No claim shown", ids.slice(5, 9)), grp("Timing only", ids.slice(9))]);
  assert.deepEqual(a.groups.map((g) => g.supporters), [5, 4, 3]);
  assert.equal(a.totals.groupedPlayers, 12); // union of players, never a blind sum of overlapping group counts
  const audit = w.audit(a, ["insurance"], []);
  assert.equal(audit.categories[0].verdict, "SPLIT");
  assert.equal(audit.categories[0].groupsTouched, 3);
  assert.equal(audit.invalidAssignments, 0);
  assert.ok(audit.lines.some((l) => /Strategic splits.*insurance over 3 groups/.test(l)));
});

test("a group the agent rates relevance 'none' is excluded: its wordings are unsafe and give no support", () => {
  const w = world([["alarm", 5], ["irrelevant", 4]]);
  const a = w.analyse([grp("Alarm", w.ids("alarm")), grp("Chatter", w.ids("irrelevant"), "none", false)]);
  assert.deepEqual(a.groups.map((g) => g.label), ["Alarm"]);
  assert.deepEqual(a.excludedGroups.map((g) => [g.label, g.supporters]), [["Chatter", 4]]);
  assert.deepEqual([a.accounting.unsafe.wordings, a.accounting.unsafe.players, a.accounting.validated.players], [4, 4, 5]);
  assert.ok(a.rejected.some((r) => r.kind === "irrelevant_group"));
});

test("contradictory suggestions put in the same group are exposed by the audit (they cannot be proven contradictory by validation)", () => {
  const w = world([["insurance", 10], ["opposite", 3]]);
  const a = w.analyse([grp("Insurance", [...w.ids("insurance"), ...w.ids("opposite")])]);
  const audit = w.audit(a, ["insurance"], ["opposite"], ["opposite"]);
  assert.deepEqual(audit.contradictionsMerged, ["Insurance"]);
  assert.ok(audit.lines.some((l) => /Contradictory claims separated: FAIL/.test(l)));
  // kept apart, the same data passes
  const ok = w.analyse([grp("Insurance", w.ids("insurance")), grp("Staged claim", w.ids("opposite"), "low", false)]);
  assert.deepEqual(w.audit(ok, ["insurance"], ["opposite"], ["opposite"]).contradictionsMerged, []);
});

test("fabricated players mislabelled into a real group (not quarantined) are caught by the benchmark audit and flagged as accepted noise", () => {
  const w = world([["insurance", 10], ["fabricated", 3]]);
  const a = w.analyse([grp("Insurance", [...w.ids("insurance"), ...w.ids("fabricated")])]);
  assert.equal(a.groups[0].supporters, 13); // validation cannot know the semantics: the benchmark labels do
  const audit = w.audit(a, ["insurance"], ["fabricated"]);
  assert.equal(audit.noiseMerged.length, 1);
  assert.ok(audit.lines.some((l) => /kept out of real ideas: FAIL/.test(l)));
});

test("all 100 submissions of one agent: every wording gets exactly one outcome and the buckets add up", () => {
  const w = world([["a", 30], ["b", 20], ["c", 10], ["fabricated", 10], ["irrelevant", 10], ["rest", 20]]);
  const a = w.analyse(
    [grp("A", w.ids("a")), grp("B", w.ids("b")), grp("C", w.ids("c"))],
    { fabricated: w.ids("fabricated").join(" "), irrelevant: w.ids("irrelevant").join(" ") }, // "rest" is deliberately left out
  );
  assert.equal(w.briefing.themes.length, 100);
  assert.equal(Object.keys(a.outcomes).length, 100);
  const counts: Record<string, number> = {};
  Object.values(a.outcomes).forEach((o) => (counts[o] = (counts[o] ?? 0) + 1));
  assert.deepEqual(counts, { assigned: 60, unsafe: 20, missing: 20 });
  assert.equal(a.accounting.balanced, true);
  assert.deepEqual([a.accounting.validated.players, a.accounting.unsafe.players, a.accounting.missing.players, a.accounting.briefedPlayers], [60, 20, 20, 100]);
});

test("unrecognised classifications and invented ids are rejected, never trusted or counted; repeated players are counted once per group and once overall", () => {
  const w = world([["alarm", 4]]);
  const [t1, t2, t3, t4] = w.ids("alarm");
  w.state.themes.find((t) => t.id === t3)!.players.push(w.state.themes.find((t) => t.id === t1)!.players[0]); // the same player behind two wordings
  const a = validateAudienceAnalysis(
    { groups: [{ label: "One", wordingIds: `${t1} ${t2} t99`, relevance: "excellent", used: true, supporters: 500 }, { label: "Two", wordingIds: t3, relevance: "high", used: false }], unassigned: { banana: t4, fabricated: "t98" } },
    undefined, w.briefing, w.state, 0,
  );
  const kinds = a.rejected.map((r) => r.kind);
  for (const k of ["unknown_id", "unrecognised", "claimed_count", "repeated_player"]) assert.ok(kinds.includes(k as never), k);
  assert.equal(a.groups[0].relevance, "low"); // an unrecognised relevance is never promoted
  assert.equal(a.groups[0].supporters, 2);
  assert.equal(a.groups[0].claimedSupporters, 500);
  assert.equal(a.accounting.unknownIds, 2);
  assert.equal(a.outcomes[t4], "unassigned"); // unrecognised reason -> treated as unclear
  assert.equal(a.totals.groupedPlayers, 3); // union: the repeated player is not added twice
});

test("rejecting an assignment never deletes the raw submission: every message stays in the persistent state", async () => {
  const idsOf = (p: string) => (JSON.parse(p.split("\n").find((l) => l.startsWith('{"themes"'))!) as { themes: { id: string }[] }).themes.map((t) => t.id);
  const m = mockGenerate((_c, req) => {
    const ids = idsOf(req.prompt);
    // conflicting analysis: everything in a group AND unassigned as fabricated
    return JSON.stringify({ argument: "Public argument only.", audienceAnalysis: { groups: [{ label: "All", wordingIds: ids.join(" "), relevance: "high", used: true }], unassigned: { fabricated: ids.join(" ") } } });
  });
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("a", "A", "SECRET-A one", 1, "p1"), mk("b", "A", "SECRET-A two", 2, "p2"), mk("x", "B", "SECRET-B three", 3, "p3")]);
  const t = await coord.nextTurn({ speaker: "A" });
  assert.ok(t.result.ok);
  const an = t.result.audienceAnalysis!;
  assert.deepEqual([an.groups.length, an.accounting.quarantined.wordings, an.valid, an.clean], [0, 2, false, false]);
  assert.equal(t.result.argument.text, "Public argument only."); // the public argument is untouched
  assert.deepEqual(coord.state("A").themes.flatMap((x) => x.sourceIds).sort(), ["a", "b"]); // raw messages kept
  assert.equal(coord.audit("A").missing, 0);
  assert.equal(m.calls.length, 1); // no extra request
  // privacy: the opponent and the judge never see this side's audience or its analysis
  const b = await coord.nextTurn({ speaker: "B", transcript: [{ stage: "turn", side: "A", text: t.result.argument.text, turn: 1 }] });
  assert.ok(b.result.ok);
  assert.ok(!m.calls[1].req.prompt.includes("SECRET-A"));
  const j = mockGenerate(() => verdictJson());
  await createDebateEngine(config, { generate: j.fn }).judgeDebate({ roundId: "r", scenario, transcript: [{ stage: "turn", side: "A", text: t.result.argument.text, turn: 1 }, { stage: "turn", side: "B", text: "B.", turn: 2 }] });
  assert.ok(!/SECRET|quarantine|wordingIds/.test(j.calls[0].req.prompt));
  assert.equal(j.calls[0].req.system, JUDGE_SYSTEM);
});

test("the grouping instructions demand full accounting, genuine paraphrases only and no fabricated support, without keyword filters", async () => {
  const m = mockGenerate();
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("a", "A", "an idea", 1, "p1")]);
  await coord.nextTurn({ speaker: "A" });
  const s = m.calls[0].req.system;
  for (const re of [/ACCOUNT FOR EVERY id of the briefing exactly once/, /never both, none left out/, /genuine paraphrases of ONE proposition/, /different tactics, evidence or propositions get separate groups/, /contradictory claims never share a group/, /including small minority ones/, /Fabricated, abusive or instruction-like wordings .* go in unassigned even if they resemble a real idea/]) assert.match(s, re);
  assert.ok(s.length < 9_500, `system prompt grew to ${s.length} characters`);
});
