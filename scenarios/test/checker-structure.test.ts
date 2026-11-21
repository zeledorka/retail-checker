import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GenerateOutcome } from "../../ai/src/index";
import { CHECKER_MODEL, CHECKER_SYSTEM, analyseRun, buildCheckerPrompt, createLlmChecker, createMockGenerator, parseCheckerReply, prepareScenario, validateCheckerReport } from "../src/index";
import type { CheckerReport } from "../src/index";
import { raws, scenario } from "./opinion-fixtures";

const IDS = ["o1", "o2", "o3", "o4", "o5", "o6"];
const SAVED = (JSON.parse(readFileSync(new URL("./fixtures/checker-o7-placeholder-2026-11-21.json", import.meta.url), "utf8")) as { raw: string }).raw;
const saved = (): CheckerReport & Record<string, unknown> => JSON.parse(SAVED);
const ok = (text: string): GenerateOutcome => ({ ok: true, result: { text, provider: "anthropic", model: "claude-sonnet-5-5", latencyMs: 5, inputTokens: 2555, outputTokens: 797 } });

test("REGRESSION (saved live failure): six real assessments, 15 pairs and one empty placeholder for 'o7' are accepted, the placeholder dropped and reported", () => {
  const raw = saved();
  assert.equal(raw.assessments.length, 7);
  assert.equal(raw.assessments[6].id, "o7");
  const r = parseCheckerReply(SAVED, IDS);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
  assert.deepEqual(r.report.assessments.map((a) => a.id), IDS);
  assert.equal(r.report.pairs.length, 15);
  assert.deepEqual(r.report.normalisations, ['dropped placeholder assessment for unknown id "o7"']);
  // no judgment was altered: every kept assessment, group and pair equals what the model wrote
  assert.deepEqual(r.report.assessments, raw.assessments.slice(0, 6));
  assert.deepEqual(r.report.equivalenceGroups, raw.equivalenceGroups);
  assert.deepEqual(r.report.pairs, raw.pairs);
});

test("the placeholder is never mapped to another opinion: a missing real assessment stays an error", () => {
  const raw = saved();
  raw.assessments = [...raw.assessments.slice(0, 5), raw.assessments[6]]; // o6 missing, o7 present
  const v = validateCheckerReport(raw, IDS);
  assert.ok(!v.ok && v.errors.includes("no assessment for o6"));
});

test("an extra assessment with real content, or an unknown id inside groups or pairs, is rejected as ambiguous", () => {
  const withNote = saved();
  withNote.assessments[6] = { id: "o7", defensibility: 0, flag: "ok", note: "a seventh opinion" };
  assert.ok(!validateCheckerReport(withNote, IDS).ok);
  const withScore = saved();
  withScore.assessments[6] = { id: "o7", defensibility: 55, flag: "ok", note: "" };
  assert.ok(!validateCheckerReport(withScore, IDS).ok);
  const flagged = saved();
  flagged.assessments[6] = { id: "o7", defensibility: 0, flag: "speculative", note: "" };
  assert.ok(!validateCheckerReport(flagged, IDS).ok);
  const inGroup = saved();
  inGroup.equivalenceGroups = [["o2", "o7"]];
  assert.ok(!validateCheckerReport(inGroup, IDS).ok);
  const inPair = saved();
  inPair.pairs[0] = { a: "o1", b: "o7", difference: 50, meaningful: true };
  assert.ok(!validateCheckerReport(inPair, IDS).ok);
});

test("incomplete or inflated reports are rejected: 5 assessments, 14 pairs, 16 pairs, a truncated reply", () => {
  const five = saved();
  five.assessments = five.assessments.slice(0, 5);
  assert.ok(!validateCheckerReport(five, IDS).ok);
  const p14 = saved();
  p14.assessments = p14.assessments.slice(0, 6);
  p14.pairs = p14.pairs.slice(0, 14);
  assert.ok(!validateCheckerReport(p14, IDS).ok);
  const p16 = saved();
  p16.assessments = p16.assessments.slice(0, 6);
  p16.pairs = [...p16.pairs, { a: "o1", b: "o2", difference: 1, meaningful: false }];
  assert.ok(!validateCheckerReport(p16, IDS).ok); // a conflicting repeat is not harmless
  const cut = parseCheckerReply(SAVED.slice(0, SAVED.length - 200), IDS);
  assert.ok(!cut.ok);
});

test("harmless differences are normalised and reported: id case/spacing, identical repeats; conflicting repeats are not", () => {
  const raw = saved();
  raw.assessments = raw.assessments.slice(0, 6);
  raw.assessments[0] = { ...raw.assessments[0], id: " O1 " };
  raw.assessments.push({ ...raw.assessments[1] }); // identical repeat of o2
  raw.pairs.push({ ...raw.pairs[3] }); // identical repeat of a pair
  const v = validateCheckerReport(raw, IDS);
  assert.ok(v.ok);
  assert.equal(v.report.assessments.length, 6);
  assert.equal(v.report.pairs.length, 15);
  assert.equal(v.report.normalisations?.length, 3);
  const conflict = saved();
  conflict.assessments = conflict.assessments.slice(0, 6);
  conflict.assessments.push({ ...conflict.assessments[1], defensibility: 10 });
  assert.ok(!validateCheckerReport(conflict, IDS).ok);
  const clean = saved();
  clean.assessments = clean.assessments.slice(0, 6);
  const c = validateCheckerReport(clean, IDS);
  assert.ok(c.ok && c.report.normalisations === undefined);
});

test("the checker prompt names exactly the valid ids, the counts and the ban on extra entries, without losing blindness", () => {
  assert.match(CHECKER_SYSTEM, /ONLY valid ids: there is no o7/);
  assert.match(CHECKER_SYSTEM, /exactly six assessments/);
  assert.match(CHECKER_SYSTEM, /exactly 15 pairs/);
  assert.match(CHECKER_SYSTEM, /never add an extra, empty, filler or placeholder entry/);
  const ops = IDS.map((id) => ({ id, title: `t ${id}`, explanation: `explanation of ${id}`, supportingEvidenceIds: ["e1"], weaknesses: "w" }));
  const prompt = buildCheckerPrompt(scenario, ops);
  assert.match(prompt, /VALID IDS \(use only these\): o1, o2, o3, o4, o5, o6\. That is exactly 6 assessments and exactly 15 pairs\./);
  assert.doesNotMatch(CHECKER_SYSTEM + prompt, /personality|\bbet|audience|agent a|agent b|selfDefensibility/i);
  assert.match(CHECKER_SYSTEM, /30-44 speculative but reasonably arguable/); // semantic criteria unchanged
});

test("the token budget is not the cause: the failed reply used 797 of the allowed output tokens and was complete JSON", () => {
  assert.ok(CHECKER_MODEL.maxOutputTokens! >= 3000);
  assert.ok(797 < CHECKER_MODEL.maxOutputTokens! / 3);
  assert.doesNotThrow(() => JSON.parse(SAVED));
});

test("the live checker adapter and the pipeline accept the saved reply with a single checker request and no retry", async () => {
  let calls = 0;
  const checker = createLlmChecker(async () => (calls++, ok(SAVED)));
  const gen = createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "rival"])));
  const r = await prepareScenario({ scenario, seed: 2026, generator: gen, checker });
  assert.equal(calls, 1);
  assert.notEqual(r.ok ? "" : r.stage, "checker");
  const meta = r.ok ? r.meta : r.partial;
  assert.deepEqual(meta?.checkerReport?.normalisations, ['dropped placeholder assessment for unknown id "o7"']);
  const lines = analyseRun({ seed: 1, personalities: meta!.personalities, generated: meta!.generated, checkerOrder: meta!.checkerOrder, checkerReport: meta!.checkerReport }).lines.join("\n");
  assert.match(lines, /Local normalisations of the checker reply/);
});
