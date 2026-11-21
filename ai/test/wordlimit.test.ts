import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, enforceWordLimit, PUBLIC_WORD_LIMIT } from "../src/wordlimit";
import { createDebateEngine } from "../src/debate";
import { createThemeCoordinator } from "../src/coordinator";
import type { AudienceInjection, EngineConfig, Side } from "../src/types";
import { config as baseConfig, scenario, mockGenerate, verdictJson } from "./fixtures";

const config: EngineConfig = { ...baseConfig, injections: { maxPerAgent: 3, maxChars: 200 } };
const filler = (n: number, w = "evidence") => Array.from({ length: n }, (_, k) => (k === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" "); // first word capitalised, like a real sentence
const mk = (id: string, side: Side, text: string, t: number, playerId: string): AudienceInjection => ({ id, side, text, submittedAt: t, playerId });

test("the limit is 45 words; ordinary speech and exactly 45 words are returned untouched", () => {
  assert.equal(PUBLIC_WORD_LIMIT, 45);
  const short = "The alarm proves nothing about intent. Timing is not motive!";
  const r = enforceWordLimit(short);
  assert.deepEqual([r.text, r.info.shortened, r.info.method, r.info.lossy, r.info.originalWords, r.info.finalWords], [short, false, "none", false, 10, 10]);
  const exact = `${filler(45)}.`;
  assert.equal(countWords(exact), 45);
  const e = enforceWordLimit(exact);
  assert.equal(e.text, exact);
  assert.equal(e.info.shortened, false);
  assert.equal(enforceWordLimit(`${filler(45)} extra`).info.shortened, true); // 46 words
});

test("over-long replies keep whole sentences first, with punctuation and readable prose intact", () => {
  const s1 = `${filler(19)} point one.`; // 21 words
  const s2 = `${filler(19)} point two!`; // 21 words
  const s3 = `${filler(19)} point three?`; // 21 words
  const r = enforceWordLimit(`${s1} ${s2} ${s3}`);
  assert.equal(r.text, `${s1} ${s2}`.replace(/\s+/g, " "));
  assert.deepEqual([r.info.method, r.info.lossy, r.info.originalWords, r.info.finalWords], ["sentences", false, 63, 42]);
  assert.ok(r.text.endsWith("two!"));
  assert.equal(r.info.originalText, `${s1} ${s2} ${s3}`);
});

test("a single over-long sentence is cut at a safe clause boundary and ends with a full stop", () => {
  const text = `The insurance renewal only shows the timing of a routine policy, ${filler(30, "paperwork")}, and nothing in the evidence turns that date into a motive for anyone at the museum tonight.`;
  const r = enforceWordLimit(text);
  assert.equal(r.info.method, "clause");
  assert.equal(r.info.lossy, false);
  assert.ok(r.info.finalWords <= 45 && r.text.endsWith("."));
  assert.ok(!/[,;:]\.$/.test(r.text));
  assert.ok(r.text.startsWith("The insurance renewal only shows the timing of a routine policy,"));
});

test("a clause cut is refused when what follows is a negation or qualification; the fallback never cuts right before 'not'", () => {
  // clause boundary at word 20, but what follows begins with "unless": cutting there would present a conditional claim as unconditional
  const guarded = `${filler(19)} holds, unless ${filler(40, "notes")}`;
  const g = enforceWordLimit(guarded);
  assert.ok(g.info.finalWords <= 45);
  assert.notEqual(g.info.method, "clause");
  // word 46 is "not": the cut must back off so "does not" is not reduced to "does" or a bare affirmative
  const neg = `${filler(43)} the stain does not prove anything about intent at all today.`;
  const n = enforceWordLimit(neg);
  assert.equal(n.info.method, "word-boundary");
  assert.equal(n.info.lossy, true);
  assert.ok(n.info.finalWords <= 45);
  assert.ok(!/\bdoes$|\bdoes…$/.test(n.text), n.text);
  assert.ok(n.text.endsWith("…"));
  assert.ok(!/\b(the|and|of|not|but)…$/.test(n.text));
  // dropping a trailing "However" sentence is flagged potentially lossy
  const s1 = `${filler(35)} first claim.`;
  const q = enforceWordLimit(`${s1} However, this only holds if the log is readable, which it is not.`);
  assert.equal(q.info.method, "sentences");
  assert.equal(q.info.lossy, true);
});

test("word counts match the benchmark rule (whitespace tokens) and the bound holds for awkward input", () => {
  for (const text of [`${filler(200)}`, "one\n\ntwo   three", `${filler(50)}…`, `"${filler(60)}"`, "Dave's alibi — it isn't proof; it's a claim, nothing more. ".repeat(12)]) {
    const r = enforceWordLimit(text);
    assert.ok(countWords(r.text) <= 45, text.slice(0, 30));
    assert.equal(r.info.finalWords, countWords(r.text));
  }
  assert.equal(enforceWordLimit(filler(100), 20).info.finalWords <= 20, true);
});

test("engine: a 60-word public argument inside a structured reply is bounded to 45; grouping metadata is never counted; one request", async () => {
  const long = `${filler(26)}. ${filler(19)}. ${filler(15)}.`; // 3 sentences, 60 words
  const m = mockGenerate((_c, req) =>
    req.system.includes("Output format for this turn")
      ? JSON.stringify({ argument: long, audienceAnalysis: { groups: [{ label: filler(7, "label"), wordingIds: ["t1"], relevance: "high", used: true }], unassigned: [] } })
      : "plain",
  );
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit([mk("s1", "A", "challenge the insurance motive", 1, "p1")]);
  const t = await coord.nextTurn({ speaker: "A", maxWords: 60 }); // asking for more than 45 does not lift the cap
  assert.ok(t.result.ok);
  assert.ok(t.result.argument.wordLimit!.shortened);
  assert.ok(countWords(t.result.argument.text) <= 45);
  assert.equal(t.result.argument.wordLimit!.originalWords, 60);
  assert.equal(t.result.argument.wordLimit!.finalWords, countWords(t.result.argument.text));
  assert.equal(t.result.audienceAnalysis!.groups[0].label, filler(7, "label")); // metadata untouched by the limit
  assert.equal(m.calls.length, 1); // shortening costs no request
  assert.match(m.calls[0].req.system, /Aim for 30-38 words/);
  assert.match(m.calls[0].req.system, /hard limit 45/);
});

test("engine: openings obey the same cap for Agent A and Agent B, whatever argumentMaxWords says", async () => {
  const m = mockGenerate(() => `${filler(30)}. ${filler(30)}.`);
  const engine = createDebateEngine({ ...config, argumentMaxWords: 80 }, { generate: m.fn });
  const r = await engine.generateOpeningArguments({ roundId: "r", scenario });
  assert.ok(r.ok);
  for (const s of ["A", "B"] as const) {
    assert.ok(countWords(r.arguments[s].text) <= 45);
    assert.equal(r.arguments[s].wordLimit!.method, "sentences");
  }
  assert.match(m.calls[0].req.system, /hard limit 45/);
  assert.equal(m.calls.length, 2);
  const lower = await createDebateEngine({ ...config, publicWordLimit: 20 }, { generate: m.fn }).generateOpeningArguments({ roundId: "r2", scenario });
  assert.ok(lower.ok && countWords(lower.arguments.A.text) <= 20);
});

test("the transcript, the judge and the display all use exactly the same bounded text", async () => {
  const original = `${filler(30)}. ${filler(30)}.`;
  const m = mockGenerate(() => original);
  const engine = createDebateEngine(config, { generate: m.fn });
  const t = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario });
  assert.ok(t.ok);
  const shown = t.argument.text;
  assert.notEqual(shown, original);
  const transcript = [
    { stage: "opening" as const, side: "A" as const, text: shown },
    { stage: "opening" as const, side: "B" as const, text: "B opening." },
    { stage: "turn" as const, side: "A" as const, text: shown, turn: 3 },
  ];
  const j = mockGenerate(() => verdictJson());
  await createDebateEngine(config, { generate: j.fn }).judgeDebate({ roundId: "r", scenario, transcript });
  assert.ok(j.calls[0].req.prompt.includes(shown));
  assert.ok(!j.calls[0].req.prompt.includes(`${filler(30)}. ${filler(30)}.`));
  assert.equal(t.argument.wordLimit!.originalText, original); // kept only as a private audit field
});

test("Agent A and Agent B are bounded identically", async () => {
  const m = mockGenerate(() => `${filler(60)}.`);
  const engine = createDebateEngine(config, { generate: m.fn });
  const a = await engine.generateNextTurn({ roundId: "r", speaker: "A", scenario });
  const b = await engine.generateNextTurn({ roundId: "r", speaker: "B", scenario });
  assert.ok(a.ok && b.ok);
  assert.deepEqual([a.argument.wordLimit!.method, a.argument.wordLimit!.finalWords], [b.argument.wordLimit!.method, b.argument.wordLimit!.finalWords]);
  assert.ok(a.argument.wordLimit!.lossy); // no sentence or clause boundary exists: flagged as the lossy fallback
});

// ---- Regressions from the first live Haiku run: "…, and the case was found open" (leading comma) and "…m." (broken tail) ----
import { splitSentences } from "../src/wordlimit";

test("regression: 'a.m.' is not a sentence end, so no leading comma and no 'm.' tail appear (61 -> kept whole sentences)", () => {
  const s1 = "The alarm sounded at 2 a.m., and the case was found open with no sign of force at all."; 
  const s2 = `${filler(25)}.`;
  const s3 = `${filler(17)}.`;
  const original = `${s1} ${s2} ${s3}`;
  assert.equal(countWords(original), 61);
  const r = enforceWordLimit(original);
  assert.equal(r.info.method, "sentences");
  assert.equal(r.text, `${s1} ${s2}`);
  assert.ok(!/^[,;:.]/.test(r.text) && r.text.startsWith("The alarm sounded at 2 a.m., and the case was found open"));
  assert.ok(r.info.finalWords <= 45 && r.info.originalWords === 61);
  assert.equal(r.info.originalText, original); // the untouched reply stays available for diagnosis
});

test("regression: a cut after '1:45 a.m.' never ends in a stray 'm.'", () => {
  const s1 = "The guard's log entry at 1:45 a.m. is smudged, so nobody can say who stood near the case.";
  const original = `${s1} ${filler(40)}.`;
  const r = enforceWordLimit(original);
  assert.equal(r.text, s1);
  assert.ok(!/(^|\s)m\.$/.test(r.text));
  assert.ok(r.text.endsWith("case."));
});

test("sentence splitting is contiguous and ignores abbreviations, initials, decimals and lower-case continuations", () => {
  assert.deepEqual(splitSentences("Dr. J. Smith saw 1.5 hours of footage. Nobody else did."), ["Dr. J. Smith saw 1.5 hours of footage.", "Nobody else did."]);
  assert.deepEqual(splitSentences("Items (e.g. the case, the log, etc.) were missing. The alarm rang!"), ["Items (e.g. the case, the log, etc.) were missing.", "The alarm rang!"]);
  assert.deepEqual(splitSentences("It happened at 2 a.m., then it stopped. Why? Nobody knows..."), ["It happened at 2 a.m., then it stopped.", "Why?", "Nobody knows..."]);
  const text = "First claim stands. Second claim, with a.m. times, follows. Third.";
  assert.equal(splitSentences(text).join(" "), text); // nothing is ever skipped between two slices
  assert.deepEqual(splitSentences("no terminator here"), ["no terminator here"]);
});

test("property: bounded output is never an orphaned fragment, whatever the input shape", () => {
  const inputs = [
    `${filler(70)}`,
    `, and ${filler(60)}.`,
    `${filler(30)} a.m. ${filler(30)}.`,
    `Staff said "the case was open and ${filler(60)}" afterwards.`,
    `He is not guilty ${filler(40)} but ${filler(20)}.`,
    `Mr. X and Dr. Y met at 2 p.m. ${filler(50)}.`,
    `${filler(44)} not proven.`,
    `${filler(44)} unless proven.`,
    "Dave's alibi — it isn't proof; it's a claim, nothing more. ".repeat(10),
    `${filler(12)}, ${filler(12)}; ${filler(12)}: ${filler(12)}, ${filler(12)}.`,
  ];
  for (const text of inputs) {
    const r = enforceWordLimit(text);
    assert.ok(countWords(r.text) <= 45, text.slice(0, 40));
    assert.ok(!/^[\s,;:.)\]—–-]/.test(r.text), `starts with punctuation: ${r.text.slice(0, 20)}`);
    assert.ok(!/[,;:—–-]$/.test(r.text), `ends with a separator: ${r.text.slice(-20)}`);
    assert.ok(!/(^|\s)[a-z]\.$/.test(r.text) || /a\.m\.$|p\.m\.$/.test(r.text), `broken tail: ${r.text.slice(-20)}`);
    assert.ok(!/\b(and|or|the|a|of|not|but)…?$/i.test(r.text), `dangling word: ${r.text.slice(-20)}`);
  }
});

test("no safe boundary: the lossy word-boundary fallback is flagged, keeps negations whole and is visibly cut", () => {
  const original = `${filler(40)} and the entry is not legible so nobody can say who stood near the case at all today`;
  const r = enforceWordLimit(original);
  assert.deepEqual([r.info.method, r.info.lossy], ["word-boundary", true]);
  assert.ok(r.text.endsWith("…") && countWords(r.text) <= 45);
  assert.ok(!/\bis…$|\bis not…$/.test(r.text) || /legible/.test(r.text)); // never "…is" / "…is not" with the predicate cut off
  // a clause cut inside an open quotation is refused
  const quoted = `Dave said "the stain, ${filler(50)}" and left.`;
  assert.notEqual(enforceWordLimit(quoted).info.method, "clause");
});

// ---- Conclusion-aware shortening (the central claim must survive) ----
const OBSERVED_REBUTTAL = "Agent B says the alarm timestamps a planned loss, but a staged claim would avoid tripping an alarm and drawing staff at once."; // 23 words
const OBSERVED_FACT = "Observed: the case was opened with no force."; // 8 words
const OBSERVED_INFERENCE = "Inferred: only someone with keys could open it quietly, so a rushed insider fits the evidence better."; // 17 words

test("regression (live Sonnet run): rebuttal, observation, inference: the final inference is KEPT and the background observation is dropped", () => {
  const original = `${OBSERVED_REBUTTAL} ${OBSERVED_FACT} ${OBSERVED_INFERENCE}`;
  assert.equal(countWords(original), 48);
  const r = enforceWordLimit(original);
  assert.equal(r.text, `${OBSERVED_REBUTTAL} ${OBSERVED_INFERENCE}`);
  assert.deepEqual([r.info.method, r.info.conclusion, r.info.droppedSentences, r.info.finalWords], ["priority-sentences", "kept", 1, 40]);
  assert.equal(r.info.lossy, true); // the dropped observation held a negation ("no force"): flagged, not hidden
  assert.equal(r.info.originalText, original);
  assert.ok(/fits the evidence better\.$/.test(r.text));
});

test("conclusion in the first sentence stays; trailing background is dropped first", () => {
  const first = "The alarm points to a rushed opportunist, not a planned claim."; // 11, conclusion marker
  const r = enforceWordLimit(`${first} Observed: ${filler(20)}. ${filler(18)}. The log is smudged.`);
  assert.ok(r.text.startsWith(first));
  assert.equal(r.info.conclusion, "kept");
  assert.ok(r.info.finalWords <= 45);
});

test("conclusion in the final sentence is kept even when earlier sentences would fill the space", () => {
  const last = "So the simplest explanation is a rushed insider with keys."; // 10 words, ', so'-style / explanation marker
  const original = `${filler(18)}. ${filler(18)}. ${filler(16)}. ${last}`; // 4 sentences, 72 words
  const r = enforceWordLimit(original);
  assert.ok(r.text.endsWith(last), r.text);
  assert.equal(r.info.conclusion, "kept");
  assert.ok(r.info.finalWords <= 45);
});

test("important negations and qualifiers: a kept sentence keeps its 'not proven' / 'might' / 'unless'; dropping one is flagged", () => {
  const hedged = "The renewal might be routine unless a claim exists, and nothing here is proven."; // negation/qualifier sentence, first
  const kept = enforceWordLimit(`${hedged} ${filler(40)}.`);
  assert.ok(kept.text.startsWith(hedged));
  const dropped = enforceWordLimit(`${filler(40)}. Unless the log is readable, the entry proves nothing. Therefore the case is open.`);
  assert.equal(dropped.info.lossy, true); // the dropped "Unless ..." sentence held a qualifier
  assert.ok(dropped.text.endsWith("Therefore the case is open."));
  const plain = enforceWordLimit(`${filler(30)}. ${filler(30)}.`);
  assert.equal(plain.info.lossy, false); // nothing risky was dropped
});

test("abbreviations such as 'a.m.' do not split or corrupt the kept conclusion", () => {
  const original = `${filler(30)}. The guard's entry at 1:45 a.m. is smudged, so nobody can place a thief near the case. ${filler(12)}.`;
  const r = enforceWordLimit(original);
  assert.ok(r.text.includes("1:45 a.m. is smudged, so nobody can place a thief near the case."));
  assert.ok(!/^[,.]/.test(r.text) && !/(^|\s)m\.$/.test(r.text));
  assert.equal(r.info.conclusion, "kept");
});

test("a long sentence with no safe boundary falls back to the flagged word cut and says the conclusion may be lost", () => {
  const original = `${filler(46)} therefore the insider did it.`;
  const r = enforceWordLimit(original);
  assert.deepEqual([r.info.method, r.info.lossy, r.info.conclusion], ["word-boundary", true, "possibly-lost"]);
  assert.ok(r.text.endsWith("…") && r.info.finalWords <= 45);
  const noMarker = enforceWordLimit(filler(60));
  assert.equal(noMarker.info.conclusion, "not-identified"); // nothing recognisable: not claimed either way
});

test("exactly 45 words is untouched and reports no loss", () => {
  const exact = `${filler(44)} ok.`;
  assert.equal(countWords(exact), 45);
  const r = enforceWordLimit(exact);
  assert.deepEqual([r.text, r.info.shortened, r.info.lossy, r.info.conclusion], [exact, false, false, "kept"]);
});

test("a structured reply with large private grouping metadata: only the public argument is bounded, conclusion kept, one request", async () => {
  const argument = `${OBSERVED_REBUTTAL} ${OBSERVED_FACT} ${OBSERVED_INFERENCE}`;
  const ids = Array.from({ length: 100 }, (_, k) => `t${k + 1}`).join(" ");
  const m = mockGenerate((_c, req) =>
    req.system.includes("Output format for this turn")
      ? JSON.stringify({ argument, audienceAnalysis: { groups: [{ label: "Insider with keys", wordingIds: ids, relevance: "high", used: true }], unassigned: {} } })
      : "plain",
  );
  const coord = createThemeCoordinator(createDebateEngine(config, { generate: m.fn }), { roundId: "r", scenario });
  coord.submit(Array.from({ length: 100 }, (_, k) => mk(`s${k}`, "A", `distinct wording ${k}`, k, `p${k}`)));
  const t = await coord.nextTurn({ speaker: "A" });
  assert.ok(t.result.ok);
  assert.equal(t.result.argument.text, `${OBSERVED_REBUTTAL} ${OBSERVED_INFERENCE}`);
  assert.equal(t.result.argument.wordLimit!.conclusion, "kept");
  assert.equal(t.result.argument.wordLimit!.originalText, argument);
  assert.equal(t.result.audienceAnalysis!.groups[0].supporters, 100); // the metadata is not shortened
  assert.equal(m.calls.length, 1);
});

test("the prompt asks for 30-38 words with the conclusion first and keeps the 45-word hard limit", async () => {
  const m = mockGenerate();
  await createDebateEngine(config, { generate: m.fn }).generateNextTurn({ roundId: "r", speaker: "A", scenario });
  const s = m.calls[0].req.system;
  assert.match(s, /Aim for 30-38 words/);
  assert.match(s, /hard limit 45/);
  assert.match(s, /State your main conclusion in the FIRST sentence/);
  assert.match(s, /keep any 'not' or 'might' that your claim needs/);
});

// ---- Minimal shortening for a small excess (live run: a 46-word opening was cut to 27 by dropping a whole sentence) ----
const S1 = "Agent A treats the alarm as proof of a panicked thief, but an alarm also creates an official incident timeline."; // 19 words
const S2 = "No forced entry means someone with access acted, which fits a planned insurance setup better than a random theft."; // 19 words

test("regression: a 46-word opening that is ONE word over keeps both sentences; only the padding word is deleted", () => {
  const text = `${S1} Moreover, no forced entry means someone with access acted, which fits a planned insurance setup better than random theft. Staff arrived at once, so nobody waited.`;
  assert.equal(countWords(text), 46);
  const r = enforceWordLimit(text);
  assert.equal(r.info.method, "trim");
  assert.equal(r.info.finalWords, 45);
  assert.deepEqual(r.info.removed, ["Moreover"]);
  assert.equal(r.info.lossy, false);
  assert.equal(r.info.conclusion, "kept");
  assert.equal(r.text, text.replace("Moreover, no forced", "No forced")); // nothing else changed: both rebuttal, reasoning and the closing inference survive
  assert.equal(r.info.originalText, text);
  assert.ok(r.text.includes("fits a planned insurance setup better") && r.text.includes("Staff arrived at once, so"));
});

test("padding words are deleted at safe boundaries: openers, emphasis, filler phrases, 'in order to'", () => {
  const base = "The renewal is routine paperwork and nothing in the log shows a plan, so the insider theory fits the case better"; // 20 words
  const cases: [string, string[], string][] = [
    [`Honestly, ${base} ${filler(25)}.`, ["Honestly"], `${base[0].toUpperCase()}${base.slice(1)} ${filler(25)}.`],
    [`${base}, in other words, ${filler(25)}.`, ["in other words"], `${base}, ${filler(25)}.`],
    [`${base} and it is really ${filler(25)}.`, ["really"], `${base} and it is ${filler(25)}.`],
    [`${base} in order to ${filler(25)}.`, ["in order"], `${base} to ${filler(25)}.`],
  ];
  for (const [input, removed, expected] of cases) {
    const words = countWords(input);
    const r = enforceWordLimit(input, words - removed.join(" ").split(" ").length); // one trim short of the original
    assert.equal(r.info.method, "trim", input.slice(0, 40));
    assert.deepEqual(r.info.removed, removed);
    assert.equal(r.text, expected);
    assert.equal(r.info.lossy, false);
  }
});

test("never deletes what carries meaning: negation-adjacent emphasis, hedges, 'just', 'simply', 'not at all', 'if at all', 'as well as'", () => {
  const pad = filler(30);
  const protectedTexts = [
    `The case is not really proven, ${pad}.`, // "not really" softens the negation
    `The case might perhaps be routine, ${pad}.`,
    `It is just a coincidence and simply a date, ${pad}.`,
    `The case is not at all proven, ${pad}.`,
    `We learn little if at all, ${pad}.`,
    `The alarm as well as the log matters, ${pad}.`,
  ];
  for (const t of protectedTexts) {
    const limit = countWords(t) - 1;
    const r = enforceWordLimit(t, limit);
    assert.notEqual(r.info.method, "trim", t.slice(0, 40)); // nothing safe to delete: another method (or flagged fallback) is used
    for (const kept of ["not really", "might perhaps", "just a coincidence", "simply a date", "not at all", "if at all", "as well as"]) if (t.includes(kept)) assert.ok(r.text.includes(kept) || r.info.lossy || r.info.method === "word-boundary" || r.info.method === "clause-trim", `${kept} lost silently in: ${r.text}`);
  }
});

test("a small safe trailing clause is trimmed instead of a whole sentence when no padding exists", () => {
  const lead = `${S1} The empty case was opened cleanly and the alarm rang at once, which nobody has explained yet.`; // 20 + 17 words
  const closing = `${filler(10)}.`; // sets the total to 48 (excess 3)
  const text = `${lead} ${closing}`;
  assert.equal(countWords(text), 47);
  const target = enforceWordLimit(`${text} ${filler(1)}`.trim()); // 48 words, excess 3
  assert.equal(countWords(`${text} ${filler(1)}`), 48);
  assert.equal(target.info.method, "clause-trim");
  assert.deepEqual(target.info.removed, ["which nobody has explained yet."]);
  assert.equal(target.info.droppedSentences, 0);
  assert.equal(target.info.lossy, false);
  assert.ok(target.text.includes("the alarm rang at once.")); // sentence ends cleanly where the clause was cut
  assert.ok(target.text.startsWith(S1) && target.info.finalWords <= 45);
  assert.equal(target.info.originalText, `${text} ${filler(1)}`);
});

test("a tail much longer than the excess is NOT cut as a 'minimal' clause (it would remove real content)", () => {
  const text = `${S1} No forced entry means someone with access acted, which fits a planned insurance setup better than a random theft, which nobody has explained yet. ${filler(10)}.`;
  const r = enforceWordLimit(text);
  assert.notEqual(r.info.method, "clause-trim");
  assert.ok(r.info.finalWords <= 45);
});

test("a clause trim is refused when the tail holds a negation or hedge, starts a qualification, or is the conclusion", () => {
  const head = `Agent A treats the alarm as proof of a panicked thief and nothing else matters here at all`; // 18
  for (const tail of [", but the log might be unreadable.", ", which is not proven.", ", unless the entry says otherwise.", ", so a rushed insider fits better."]) {
    const text = `${head}${tail} ${filler(26)}.`;
    const excess = countWords(text) - 45;
    assert.ok(excess >= 1 && excess <= 8, `excess ${excess}`);
    const r = enforceWordLimit(text);
    assert.notEqual(r.info.method, "clause-trim", tail);
    assert.ok(r.info.finalWords <= 45);
  }
});

test("when no minimal cut is safe, the conclusion-aware fallback still applies and the loss is flagged", () => {
  const text = `${filler(30)}. The log is not readable, so a rushed insider fits better. ${filler(14)}.`; // 51 words, no padding, no safe tail
  const r = enforceWordLimit(text);
  assert.ok(["sentences", "priority-sentences"].includes(r.info.method), r.info.method);
  assert.equal(r.info.conclusion, "kept");
  assert.ok(r.text.includes("fits better"));
  assert.ok(r.info.finalWords <= 45);
  const noBoundary = enforceWordLimit(`${filler(40)} the entry is not readable here today ok`); // 49 words, one sentence, no comma
  assert.deepEqual([noBoundary.info.method, noBoundary.info.lossy], ["word-boundary", true]);
});

test("a large excess is not 'trimmed': padding removal only applies to an excess of 8 words or fewer", () => {
  const text = `Honestly, ${filler(54)}.`; // 55 words, excess 10
  const r = enforceWordLimit(text);
  assert.notEqual(r.info.method, "trim");
  assert.ok(r.info.finalWords <= 45);
});

test("sentence boundaries survive a trim: a removed opener mid-text capitalises the next word, and 'a.m.' is left alone", () => {
  const text = `The entry at 1:45 a.m. is smudged and proves nothing. Furthermore, the alarm fits a rushed theft better than a plan. ${filler(22)}.`;
  const n = countWords(text);
  const r = enforceWordLimit(text, n - 1);
  assert.equal(r.info.method, "trim");
  assert.deepEqual(r.info.removed, ["Furthermore"]);
  assert.ok(r.text.includes("1:45 a.m. is smudged and proves nothing. The alarm fits a rushed theft"));
  assert.ok(!/\s{2}|\s,|,,|\.\./.test(r.text));
});

test("engine: the trimmed text is what the transcript, the judge and the display get; the original stays in the diagnostics; no extra request", async () => {
  const text = `${S1} Moreover, no forced entry means someone with access acted, which fits a planned insurance setup better than random theft. Staff arrived at once, so nobody waited.`;
  const m = mockGenerate(() => text);
  const t = await createDebateEngine(config, { generate: m.fn }).generateNextTurn({ roundId: "r", speaker: "B", scenario });
  assert.ok(t.ok);
  assert.equal(t.argument.wordLimit!.method, "trim");
  assert.equal(countWords(t.argument.text), 45);
  assert.equal(t.argument.wordLimit!.originalText, text);
  assert.equal(m.calls.length, 1);
  const j = mockGenerate(() => verdictJson());
  await createDebateEngine(config, { generate: j.fn }).judgeDebate({ roundId: "r", scenario, transcript: [{ stage: "turn", side: "B", text: t.argument.text, turn: 3 }, { stage: "turn", side: "A", text: "A.", turn: 4 }] });
  assert.ok(j.calls[0].req.prompt.includes(t.argument.text));
  assert.ok(!j.calls[0].req.prompt.includes("Moreover"));
});
