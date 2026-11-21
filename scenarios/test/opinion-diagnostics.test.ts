import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseRun, createMockChecker, createMockGenerator, prepareScenario } from "../src/index";
import { contentReport, raws, scenario } from "./opinion-fixtures";

const gen = () => createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["outsiderParaphrase", "insider", "maintenance"])));

test("a failed selection still returns everything needed to diagnose it: opinions, checker report, per-opinion and per-pair verdicts", async () => {
  const checker = createMockChecker(({ opinions }) => {
    const rep = contentReport(opinions, { staged: { defensibility: 22 }, loan: { defensibility: 25 }, insider: { flag: "contradicted", defensibility: 20 }, maintenance: { defensibility: 27 } });
    return { ...rep, assessments: rep.assessments.map((a) => (a.flag === "contradicted" ? { ...a, note: "No evidence mentions a staff key, so this is unsupported by the record" } : a)) };
  });
  const r = await prepareScenario({ scenario, seed: 3, generator: gen(), checker });
  assert.ok(!r.ok && r.stage === "selection");
  assert.ok(r.partial?.generated && r.partial.checkerReport && r.partial.checkerOrder);
  const d = r.selection!.diagnostics;
  assert.equal(d.opinions.length, 6);
  assert.equal(d.pairStatus.length, 9);
  assert.equal(d.opinions.filter((o) => !o.usable).length, 4);
  assert.ok(d.opinions.some((o) => /defensibility 22 < 30/.test(o.reason ?? "")));
  assert.ok(d.opinions.some((o) => o.reason === "flagged contradicted"));
  const a = analyseRun(r.partial!, d);
  const text = a.lines.join("\n");
  assert.match(text, /Checker assessments/);
  assert.match(text, /Equivalence groups: \{/);
  assert.equal(a.lines.filter((l) => /^  o\d\(.*\) vs o\d\(.*\): \d+ \/ (true|false)$/.test(l)).length, 15);
  assert.equal(a.signals.checkerContradicted, 1);
  assert.equal(a.signals.flagsWhoseReasonLooksLikeMissingEvidence, 1); // the note reads as missing evidence being used as contradiction
  assert.ok(Number(a.signals.checkerBelowThreshold) >= 3);
  assert.match(String(a.signals.likelyOrigin), /checker/);
});

test("an invalid checker reply keeps the raw text for diagnosis", async () => {
  const bad = createMockChecker(() => ({ ok: false, error: { code: "invalid_output", message: "bad", retryable: true, raw: "not json at all" } }));
  const r = await prepareScenario({ scenario, seed: 4, generator: gen(), checker: bad, checkerRetries: 0 });
  assert.ok(!r.ok && r.stage === "checker" && r.error?.raw === "not json at all" && r.partial?.generated);
});

test("diagnostics report distinctness: paraphrases show high word overlap and distinct readings low", async () => {
  const r = await prepareScenario({ scenario, seed: 5, generator: gen(), checker: createMockChecker(({ opinions }) => contentReport(opinions)) });
  assert.ok(r.ok);
  const a = analyseRun({ seed: 5, personalities: r.meta.personalities, generated: r.meta.generated, checkerOrder: r.meta.checkerOrder, checkerReport: r.meta.checkerReport }, r.meta.selection.diagnostics);
  assert.ok(a.lines.some((l) => l.startsWith("Distinctness")));
  assert.match(a.lines.join("\n"), /A-B pair outcomes:/);
});
