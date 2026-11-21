import { test } from "node:test";
import assert from "node:assert/strict";
import { PREPARED_CASES, similarity, validateScenarioCase } from "../src/index";

/**
 * Authoring review map (test fixture, not production data): for every interpretation, which evidence items (1-based) give it
 * legitimate support, which weaken it, and its causal family. It records the intent of revision 2 of the prepared cases and is
 * what these tests check; it is the author's judgement, not a model result. Items listed under `weakens` make a reading harder to
 * hold but never rule it out.
 */
type Entry = { supports: number[]; weakens: number[]; cause: string };
const REVIEW: Record<string, { ids: string[]; map: Record<string, Entry> }> = {
  "empty-display-case": {
    ids: ["outsider-opportunist", "staged-theft", "handling-error", "personal-motive-insider"],
    map: {
      "outsider-opportunist": { supports: [2, 3, 4], weakens: [1], cause: "outsider acting on impulse" },
      "staged-theft": { supports: [1, 3, 5], weakens: [6], cause: "planned insurance fraud" },
      "handling-error": { supports: [2, 4, 6], weakens: [3], cause: "no theft: unlogged official move" },
      "personal-motive-insider": { supports: [2, 3, 4], weakens: [], cause: "staff member with a private motive" },
    },
  },
  "silent-call": {
    ids: ["prank-call", "equipment-fault", "targeted-intimidation", "person-in-difficulty"],
    map: {
      "prank-call": { supports: [3, 4, 5], weakens: [], cause: "playful human caller" },
      "equipment-fault": { supports: [2, 4, 6], weakens: [3, 5], cause: "technical fault" },
      "targeted-intimidation": { supports: [2, 4], weakens: [5], cause: "hostile human caller" },
      "person-in-difficulty": { supports: [2, 3, 1], weakens: [4], cause: "caller in distress or dialling in error" },
    },
  },
  "open-gate": {
    ids: ["sitter-routine", "scouting-visits", "faulty-latch", "arranged-collection"],
    map: {
      "sitter-routine": { supports: [1, 3], weakens: [], cause: "authorised person's forgetfulness" },
      "scouting-visits": { supports: [2, 4, 6], weakens: [], cause: "hostile reconnaissance" },
      "faulty-latch": { supports: [1, 2, 5], weakens: [4, 6], cause: "mechanical failure and weather" },
      "arranged-collection": { supports: [2, 3, 6], weakens: [4], cause: "pre-arranged third-party visit" },
    },
  },
  "missing-rows": {
    ids: ["insider-deletion", "account-compromised", "automation-misfire", "honest-mistake"],
    map: {
      "insider-deletion": { supports: [1, 2, 5], weakens: [6], cause: "deliberate act by a colleague" },
      "account-compromised": { supports: [1, 2, 3], weakens: [6], cause: "outside attacker" },
      "automation-misfire": { supports: [2, 4, 5], weakens: [3], cause: "software failure" },
      "honest-mistake": { supports: [3, 5, 6], weakens: [], cause: "accidental user error" },
    },
  },
  "parked-van": {
    ids: ["personal-errand", "off-book-handover", "late-added-stop", "breakdown-or-health"],
    map: {
      "personal-errand": { supports: [1, 2, 3], weakens: [], cause: "driver's private life" },
      "off-book-handover": { supports: [1, 2, 3], weakens: [4], cause: "illicit diversion of goods" },
      "late-added-stop": { supports: [1, 2, 5], weakens: [3], cause: "legitimate work missing from the system" },
      "breakdown-or-health": { supports: [1, 6], weakens: [2, 3], cause: "vehicle or health problem" },
    },
  },
  "drawn-curtains": {
    ids: ["smart-timer", "hiding-at-home", "someone-else-living", "caretaker-visits"],
    map: {
      "smart-timer": { supports: [1, 2, 5], weakens: [3, 4], cause: "automation, tenant absent" },
      "hiding-at-home": { supports: [2, 4, 6], weakens: [], cause: "tenant avoiding contact" },
      "someone-else-living": { supports: [1, 3, 4], weakens: [], cause: "resident guest" },
      "caretaker-visits": { supports: [1, 3, 6], weakens: [], cause: "arranged visitor, tenant away" },
    },
  },
};

const byId = (id: string) => PREPARED_CASES.find((c) => c.id === id)!;

test("the six prepared cases are all still valid, with stable ids that match the review map", () => {
  assert.equal(PREPARED_CASES.length, 6);
  for (const c of PREPARED_CASES) {
    assert.ok(validateScenarioCase(c).ok, c.id);
    assert.deepEqual(c.interpretations.map((i) => i.id), REVIEW[c.id].ids, `${c.id}: interpretation ids changed`);
    assert.ok(c.interpretations.length >= 3 && c.interpretations.length <= 4);
    assert.deepEqual(Object.keys(REVIEW[c.id].map).sort(), [...REVIEW[c.id].ids].sort());
  }
  assert.deepEqual(PREPARED_CASES.map((c) => c.id), Object.keys(REVIEW));
});

test("every interpretation has some legitimate support, and at least two have solid support (two or more items)", () => {
  for (const [id, r] of Object.entries(REVIEW)) {
    const c = byId(id);
    for (const [iid, e] of Object.entries(r.map)) {
      assert.ok(e.supports.length >= 1, `${id}/${iid}`);
      for (const n of [...e.supports, ...e.weakens]) assert.ok(n >= 1 && n <= c.evidence.length, `${id}/${iid}: evidence ${n} does not exist`);
      assert.ok(e.supports.every((s) => !e.weakens.includes(s)), `${id}/${iid}: an item cannot both support and weaken`);
    }
    assert.ok(Object.values(r.map).filter((e) => e.supports.length >= 2).length >= 2, id);
  }
});

test("no single reading dominates by evidence: the best-supported reading leads the runner-up by at most one item", () => {
  for (const [id, r] of Object.entries(REVIEW)) {
    const counts = Object.values(r.map).map((e) => e.supports.length - e.weakens.length * 0).sort((a, b) => b - a);
    assert.ok(counts[0] - counts[1] <= 1, `${id}: ${counts.join(",")}`);
  }
});

test("nothing is settled: no evidence item is decisive (supports one reading and weakens all the others), and no reading is supported by every item", () => {
  for (const [id, r] of Object.entries(REVIEW)) {
    const c = byId(id);
    const entries = Object.values(r.map);
    for (let n = 1; n <= c.evidence.length; n++) {
      const supporting = entries.filter((e) => e.supports.includes(n)).length;
      const weakening = entries.filter((e) => e.weakens.includes(n)).length;
      assert.ok(!(supporting === 1 && weakening === entries.length - 1), `${id}: item ${n} points at a single reading and against all the rest`);
    }
    for (const e of entries) assert.ok(e.supports.length < c.evidence.length, `${id}: a reading is supported by every item`);
  }
});

test("the evidence cuts both ways: several items support one reading while weakening another, giving the debate cross-examination material", () => {
  for (const [id, r] of Object.entries(REVIEW)) {
    const c = byId(id);
    const doubleEdged = Array.from({ length: c.evidence.length }, (_, k) => k + 1).filter((n) => Object.values(r.map).some((e) => e.supports.includes(n)) && Object.values(r.map).some((e) => e.weakens.includes(n)));
    assert.ok(doubleEdged.length >= 2, `${id}: only ${doubleEdged.length} double-edged item(s)`);
    assert.ok(c.evidence.length >= 5, `${id}: ${c.evidence.length} evidence items give little to argue over for eight turns`);
  }
});

test("each interpretation has a distinct causal mechanism, not just different wording", () => {
  for (const [id, r] of Object.entries(REVIEW)) {
    const causes = Object.values(r.map).map((e) => e.cause);
    assert.equal(new Set(causes).size, causes.length, id);
    const c = byId(id);
    for (let i = 0; i < c.interpretations.length; i++)
      for (let j = i + 1; j < c.interpretations.length; j++) assert.ok(similarity(c.interpretations[i].description, c.interpretations[j].description) < 0.4, `${id}: ${c.interpretations[i].id} vs ${c.interpretations[j].id}`);
  }
});

test("The Empty Display Case: handling-error no longer leads, and the theft readings have their own supporting evidence", () => {
  const c = byId("empty-display-case");
  assert.ok(!c.evidence.some((e) => /conservator/i.test(e))); // the item that made the unlogged move the obvious answer
  const m = REVIEW["empty-display-case"].map;
  assert.ok(m["handling-error"].supports.length <= Math.max(...Object.values(m).map((e) => e.supports.length)));
  assert.ok(m["handling-error"].weakens.length >= 1); // the 1:58 a.m. door-sensor log and the fast response make an innocent night move harder to hold
  assert.ok(c.evidence.some((e) => /door sensor logged an opening at 1:58/.test(e)));
  assert.ok(c.evidence.some((e) => /asked to borrow/.test(e))); // keeps the innocent reading alive without resolving it
  assert.ok(!c.interpretations.some((i) => i.id === "opportunistic-theft")); // replaced by the outsider reading: no longer a twin of the insider
  const out = c.interpretations.find((i) => i.id === "outsider-opportunist")!;
  const ins = c.interpretations.find((i) => i.id === "personal-motive-insider")!;
  assert.ok(similarity(out.description, ins.description) < 0.25);
});

test("The Silent Call: the two technical explanations are now one, and the fourth reading comes from a different family", () => {
  const c = byId("silent-call");
  assert.ok(!c.interpretations.some((i) => i.id === "wrong-number-loop"));
  const technical = c.interpretations.filter((i) => /device|panel|exchange|dialler|equipment/i.test(i.description));
  assert.equal(technical.length, 1);
  assert.ok(c.interpretations.some((i) => i.id === "person-in-difficulty"));
  assert.ok(c.evidence.some((e) => /cough/.test(e))); // a human-presence clue that equipment alone explains poorly
});

test("The Parked Van: the two driver-absence readings now differ in cause (private life versus unrecorded work)", () => {
  const c = byId("parked-van");
  assert.ok(!c.interpretations.some((i) => i.id === "unrecorded-break"));
  const errand = c.interpretations.find((i) => i.id === "personal-errand")!;
  const stop = c.interpretations.find((i) => i.id === "late-added-stop")!;
  assert.ok(similarity(errand.description, stop.description) < 0.2);
  assert.match(errand.description, /private/);
  assert.match(stop.description, /dispatch system/);
  assert.ok(c.evidence.some((e) => /two customers on that street/.test(e)));
});

test("The Open Gate, The Missing Rows and The Drawn Curtains: the identified imbalances are addressed", () => {
  const gate = byId("open-gate");
  assert.ok(!gate.evidence.some((e) => /shut again/i.test(e))); // implied a person closes it every evening and sank the latch reading
  assert.ok(gate.evidence.some((e) => /latch is old/.test(e)) && gate.evidence.some((e) => /van parked/.test(e)));
  assert.ok(gate.interpretations.some((i) => i.id === "arranged-collection") && !gate.interpretations.some((i) => i.id === "legitimate-visitor"));
  const rows = byId("missing-rows");
  assert.ok(rows.evidence.some((e) => /only written when it finishes without error/.test(e))); // restores the macro reading the old log line contradicted
  assert.ok(rows.evidence.some((e) => /new laptop/.test(e)));
  const curtains = byId("drawn-curtains");
  assert.ok(!curtains.evidence.some((e) => /exactly 6 p\.m\./.test(e))); // the exact timing made the timer almost proof
  assert.ok(curtains.evidence.some((e) => /give or take a few minutes/.test(e)));
  assert.ok(curtains.evidence.some((e) => /nobody knows which devices it controls/.test(e)));
});

test("ambiguity is preserved: no evidence item names a culprit, a motive or a verdict, and the public text stays readable", () => {
  const verdictWords = /\b(confess|admitted|proved?|proof|guilty|culprit|caught on camera)\b/i;
  for (const c of PREPARED_CASES) {
    for (const e of c.evidence) {
      assert.doesNotMatch(e, verdictWords, `${c.id}: "${e}"`);
      assert.ok(e.length <= 160, `${c.id}: evidence too long to read on a projector (${e.length})`);
    }
    assert.ok(c.description.length <= 260, `${c.id}: description ${c.description.length}`);
    assert.ok(c.interpretations.every((i) => i.description.length <= 240 && i.label.length <= 40), c.id);
  }
});
