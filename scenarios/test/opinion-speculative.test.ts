import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { startRound } from "../../ai/src/index";
import { CHECKER_SYSTEM, DEFAULT_SELECTION, analyseRun, anonymise, createMockChecker, createMockGenerator, prepareScenario, selectFinalPair, validateCheckerReport, validateOpinions } from "../src/index";
import type { CheckerReport, GeneratedOpinion } from "../src/index";
import { contentReport, opinionsFor, raws, scenario } from "./opinion-fixtures";
import type { Key, Spec } from "./opinion-fixtures";

type Keys = [Key, Key, Key];
function pick(a: Keys, b: Keys, spec: Spec, seed = 1, orderSeed = seed, opts: Record<string, number> = {}) {
  const A = opinionsFor("A", a);
  const B = opinionsFor("B", b);
  const { checkerOpinions, order } = anonymise([...A, ...B], orderSeed);
  return selectFinalPair({ opinionsA: A, opinionsB: B, checkerOrder: order, report: contentReport(checkerOpinions, spec) }, { seed, ...opts });
}
// Only A's "outsider" and B's "insider" can possibly be eligible in these cases, so the outcome isolates one opinion pair.
const only = (x: Spec[Key], y: Spec[Key]): Spec => ({ outsider: x, staged: { defensibility: 5, flag: "implausible" }, loan: { defensibility: 5, flag: "implausible" }, insider: y, maintenance: { defensibility: 5, flag: "implausible" } });
const A3: Keys = ["outsider", "staged", "loan"];
const B3: Keys = ["insider", "maintenance", "loan"];

test("the default threshold is 30, the difference and balance limits are unchanged, and the threshold stays configurable", () => {
  assert.deepEqual(DEFAULT_SELECTION, { minDefensibility: 30, minDifference: 40, maxBalanceGap: 30, rankBonus: [6, 3, 0], tieMargin: 2 });
  assert.ok(!pick(A3, B3, only({ defensibility: 40 }, { defensibility: 40 }), 1, 1, { minDefensibility: 45 }).ok);
  assert.ok(pick(A3, B3, only({ defensibility: 40 }, { defensibility: 40 }), 1, 1, { minDefensibility: 40 }).ok);
});

test("a score of 29 is ineligible and a score of 30 is eligible", () => {
  assert.ok(!pick(A3, B3, only({ defensibility: 29 }, { defensibility: 40 })).ok);
  assert.ok(!pick(A3, B3, only({ defensibility: 40 }, { defensibility: 29 })).ok);
  assert.ok(pick(A3, B3, only({ defensibility: 30 }, { defensibility: 40 })).ok);
});

test("a speculative opinion scoring 35 stays eligible, with no penalty for the speculative flag", () => {
  const r = pick(A3, B3, only({ defensibility: 35, flag: "speculative" }, { defensibility: 38, flag: "speculative" }));
  assert.ok(r.ok && r.a.title === "Outsider on impulse" && r.diagnostics.opinions.find((o) => o.id === r.a.id)!.usable);
  const speculative = pick(A3, B3, only({ defensibility: 40, flag: "speculative" }, { defensibility: 40 }));
  const legacy = pick(A3, B3, only({ defensibility: 40, flag: "unsupported" }, { defensibility: 40 }));
  assert.ok(speculative.ok && legacy.ok);
  assert.equal(speculative.chosen.score - legacy.chosen.score, 8); // only the legacy "unsupported" flag keeps its 8-point penalty
});

test("an unverified actor, motive or mechanism is not a reason to reject: the checker's score and flag decide, not the missing proof", () => {
  const r = pick(A3, B3, only({ defensibility: 33, flag: "speculative" }, { defensibility: 36, flag: "speculative" }));
  assert.ok(r.ok);
  assert.equal(r.diagnostics.pairsValid, 1); // every other opinion was removed deliberately; only this speculative pair survived
});

test("missing direct evidence is not contradiction: the checker is told the difference and may flag 'speculative' instead", () => {
  assert.match(CHECKER_SYSTEM, /Absence of supporting evidence is NOT contradiction/);
  assert.match(CHECKER_SYSTEM, /"there is no evidence proving this happened"/);
  assert.match(CHECKER_SYSTEM, /"the evidence shows this could not have happened"/);
  assert.match(CHECKER_SYSTEM, /An unverified actor, motive or mechanism is not by itself a reason to flag or to score low/);
  assert.match(CHECKER_SYSTEM, /Only "contradicted" and "implausible" make an opinion ineligible/);
  for (const a of [/0-19 implausible/, /20-29 extremely speculative/, /30-44 speculative but reasonably arguable/, /45-69 a plausible interpretation/, /70-100 strongly defensible/, /NOT the probability that the explanation is correct/]) assert.match(CHECKER_SYSTEM, a);
  assert.match(CHECKER_SYSTEM, /do not adjust them to make opinions look balanced or opposed/);
  assert.doesNotMatch(CHECKER_SYSTEM, /personality|\bbet|audience|agent a|agent b/i);
  const rep = { assessments: [{ id: "o1", defensibility: 33, flag: "speculative", note: "x" }], equivalenceGroups: [], pairs: [] };
  assert.ok(!validateCheckerReport(rep, ["o1", "o2"]).ok); // still must be complete...
  const { checkerOpinions } = anonymise([...opinionsFor("A", A3), ...opinionsFor("B", B3)], 1);
  const full = contentReport(checkerOpinions, { outsider: { flag: "speculative" }, staged: { flag: "implausible" } });
  assert.ok(validateCheckerReport(full, checkerOpinions.map((o) => o.id)).ok); // ...but the new flags are valid
});

test("directly contradicted and implausible opinions stay excluded whatever their score", () => {
  for (const flag of ["contradicted", "implausible"] as const) {
    const r = pick(A3, B3, only({ defensibility: 95, flag }, { defensibility: 90 }));
    assert.ok(!r.ok);
    assert.equal(r.diagnostics.usableA, 0);
    assert.match(r.diagnostics.opinions.find((o) => o.id === "A1")!.reason!, new RegExp(`flagged ${flag}`));
  }
});

test("fabricated evidence stays excluded: invented ids fail validation locally, and fabricated 'established facts' are flagged implausible by the checker", () => {
  const good = raws(["outsider", "staged", "loan"]);
  assert.equal(validateOpinions([{ ...good[0], supportingEvidenceIds: ["e1", "e50"] }, good[1], good[2]], scenario).ok, false);
  assert.ok(!pick(A3, B3, only({ defensibility: 80, flag: "implausible" }, { defensibility: 80 })).ok);
});

test("equivalent interpretations stay excluded even when both are speculative and above the threshold", () => {
  const r = pick(["outsider", "staged", "loan"], ["outsiderParaphrase", "maintenance", "insider"], { outsider: { defensibility: 40, flag: "speculative" }, outsiderParaphrase: { defensibility: 40, flag: "speculative" }, staged: { defensibility: 5, flag: "implausible" }, loan: { defensibility: 5, flag: "implausible" }, maintenance: { defensibility: 5, flag: "implausible" }, insider: { defensibility: 5, flag: "implausible" } });
  assert.ok(!r.ok && r.diagnostics.rejected.same_explanation === 1);
});

test("two genuinely different speculative interpretations may form a valid pair", () => {
  const r = pick(["staged", "loan", "maintenance"], ["insider", "outsider", "insider"], { staged: { defensibility: 32, flag: "speculative" }, loan: { defensibility: 33, flag: "speculative" }, maintenance: { defensibility: 31, flag: "speculative" }, insider: { defensibility: 34, flag: "speculative" }, outsider: { defensibility: 36, flag: "speculative" } });
  assert.ok(r.ok && r.chosen.difference >= 40 && r.chosen.defensibilityA < 45 && r.chosen.defensibilityB < 45);
});

test("a defensibility gap above 30 is still rejected, and a gap of exactly 30 is allowed", () => {
  const wide = pick(A3, B3, only({ defensibility: 35, flag: "speculative" }, { defensibility: 66 }));
  assert.ok(!wide.ok && wide.diagnostics.rejected.unbalanced === 1);
  assert.ok(pick(A3, B3, only({ defensibility: 35, flag: "speculative" }, { defensibility: 65 })).ok);
});

test("blindness and symmetry are intact at the new threshold: label swap mirrors the result and checker order does not change it", () => {
  const spec: Spec = { outsider: { defensibility: 33, flag: "speculative" }, staged: { defensibility: 36, flag: "speculative" }, loan: { defensibility: 31 }, insider: { defensibility: 38, flag: "speculative" }, maintenance: { defensibility: 30, flag: "speculative" } };
  let swap = 0;
  let shuffle = 0;
  for (let s = 0; s < 80; s++) {
    const base = pick(["outsider", "staged", "loan"], ["insider", "maintenance", "staged"], spec, s, s);
    const swapped = pick(["insider", "maintenance", "staged"], ["outsider", "staged", "loan"], spec, s, s);
    const reshuffled = pick(["outsider", "staged", "loan"], ["insider", "maintenance", "staged"], spec, s, s + 5000);
    const k = (r: typeof base) => (r.ok ? `${r.a.title}|${r.b.title}` : "none");
    if (k(base) !== (swapped.ok ? `${swapped.b.title}|${swapped.a.title}` : "none")) swap++;
    if (k(base) !== k(reshuffled)) shuffle++;
  }
  console.log(`[recorded] threshold 30: label swap changed the pair in ${swap}/80 runs, checker order in ${shuffle}/80`);
  assert.equal(swap + shuffle, 0);
});

test("a pair of speculative opinions prepares end to end and the result is startRound-compatible", async () => {
  const gen = createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "rival"])));
  const checker = createMockChecker(({ opinions }) => contentReport(opinions, { outsider: { defensibility: 33, flag: "speculative" }, staged: { defensibility: 32, flag: "speculative" }, loan: { defensibility: 34, flag: "speculative" }, insider: { defensibility: 36, flag: "speculative" }, maintenance: { defensibility: 31, flag: "speculative" }, rival: { defensibility: 30, flag: "speculative" } }));
  const r = await prepareScenario({ scenario, seed: 21, generator: gen, checker });
  assert.ok(r.ok && r.meta.llmCalls === 3);
  assert.ok(startRound({ roundId: "room-1:round-1", scenario: r.scenario }).ok);
});

test("REPLAY of saved live benchmark dumps (selector only, no model call): the recorded failures at the old threshold", () => {
  const dir = new URL("../validation/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^live-opinions-.*\.json$/.test(f));
  assert.ok(files.length >= 1);
  const out: string[] = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { dumps: { scenario: string; result: { ok: boolean; meta?: { seed: number; generated: Record<"A" | "B", GeneratedOpinion[]>; checkerOrder: { opinionId: string; anonId: string }[]; checkerReport: CheckerReport }; partial?: { seed: number; generated: Record<"A" | "B", GeneratedOpinion[]>; checkerOrder: { opinionId: string; anonId: string }[]; checkerReport: CheckerReport } } }[] };
    for (const x of d.dumps) {
      const m = x.result.meta ?? x.result.partial!;
      const run = (min: number) => selectFinalPair({ opinionsA: m.generated.A, opinionsB: m.generated.B, checkerOrder: m.checkerOrder, report: m.checkerReport }, { seed: m.seed, minDefensibility: min });
      const old = run(45);
      const now = run(30);
      assert.equal(old.ok, x.result.ok, `${f} ${x.scenario}: the old-threshold replay must reproduce the recorded outcome`);
      assert.ok(now.ok, `${f} ${x.scenario}`);
      out.push(`${x.scenario}: recorded ${x.result.ok ? "success" : "failure"} -> threshold 30 selector-only replay ${now.ok ? "success" : "failure"}`);
    }
  }
  console.log(`[replay, selector only; not a prediction of the updated checker prompt]\n  ${out.join("\n  ")}`);
});

test("diagnostics count speculative flags separately from contradictions", () => {
  const A = opinionsFor("A", A3);
  const B = opinionsFor("B", B3);
  const { checkerOpinions, order } = anonymise([...A, ...B], 3);
  const report = contentReport(checkerOpinions, { outsider: { flag: "speculative", defensibility: 33 }, staged: { flag: "contradicted", defensibility: 10 } });
  const a = analyseRun({ seed: 3, personalities: { A: {} as never, B: {} as never }, generated: { A, B }, checkerOrder: order, checkerReport: report });
  assert.equal(a.signals.checkerSpeculative, 1);
  assert.equal(a.signals.checkerContradicted, 1);
});
