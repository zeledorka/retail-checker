import { test } from "node:test";
import assert from "node:assert/strict";
import { PREPARED_CASES, buildAudience, eligibleAt } from "../src/index";
import { designed } from "./full-fixtures";

const ev = designed().evidence;
const make = (seed = 11, evidence = ev) => buildAudience({ seed, evidence, interpretationA: "Someone with a key moved the keg deliberately overnight.", interpretationB: "A courier mix-up sent the keg to the neighbouring unit." });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

test("exactly 200 submissions, 100 per side, 200 unique players and ids, one submission per player", () => {
  const a = make();
  assert.equal(a.submissions.length, 200);
  assert.equal(a.submissions.filter((s) => s.side === "A").length, 100);
  assert.equal(a.submissions.filter((s) => s.side === "B").length, 100);
  assert.equal(new Set(a.submissions.map((s) => s.playerId)).size, 200);
  assert.equal(new Set(a.submissions.map((s) => s.id)).size, 200);
  for (const s of a.submissions) assert.ok(s.text.length > 0 && s.text.length <= 190 && typeof s.submittedAt === "number");
});

test("the mix is realistic and exact per side: duplicates, paraphrase clusters, useful, minor, irrelevant, adversarial, unsupported", () => {
  const a = make();
  for (const side of ["A", "B"] as const) {
    const mine = a.submissions.filter((s) => s.side === side).map((s) => a.meta[s.id].kind);
    const n = (k: string) => mine.filter((x) => x === k).length;
    assert.deepEqual({ identical: n("identical"), paraphrase: n("paraphrase"), useful: n("useful"), minor: n("minor"), irrelevant: n("irrelevant"), adversarial: n("adversarial"), unsupported: n("unsupported") }, { identical: 19, paraphrase: 18, useful: 23, minor: 12, irrelevant: 8, adversarial: 10, unsupported: 10 });
    assert.equal(a.clusters[`${side}-dup1`].length, 12);
    assert.equal(a.clusters[`${side}-dup2`].length, 7);
    for (const c of [1, 2, 3]) assert.equal(a.clusters[`${side}-para${c}`].length, 6);
  }
});

test("identical wordings differ only in case, punctuation and spacing; paraphrases are genuinely different texts", () => {
  const a = make();
  const text = (id: string) => a.submissions.find((s) => s.id === id)!.text;
  for (const side of ["A", "B"]) for (const g of ["dup1", "dup2"]) {
    const ids = a.clusters[`${side}-${g}`];
    assert.equal(new Set(ids.map((id) => norm(text(id)))).size, 1);
  }
  assert.ok(new Set(a.clusters["A-dup1"].map((id) => text(id))).size >= 3); // case/punctuation/spacing variants really occur
  for (const side of ["A", "B"]) for (const c of [1, 2, 3]) assert.equal(new Set(a.clusters[`${side}-para${c}`].map((id) => norm(text(id)))).size, 6);
});

test("adversarial instructions carry a canary and unsupported claims name invented people; neither appears in public case text", () => {
  const a = make();
  const adv = a.submissions.filter((s) => a.meta[s.id].kind === "adversarial");
  assert.equal(adv.length, 20);
  for (const s of adv) assert.ok(a.canaries.some((c) => s.text.includes(c)), s.text);
  const uns = a.submissions.filter((s) => a.meta[s.id].kind === "unsupported");
  for (const s of uns) assert.ok(a.fabricatedNames.some((n) => s.text.includes(n)), s.text);
  for (const e of ev) for (const c of a.canaries) assert.ok(!e.includes(c));
});

test("arrival is gradual and cumulative: 25 -> 200 over eight turns, each submission eligible from exactly one turn onward", () => {
  const a = make();
  assert.deepEqual(a.schedule, [25, 50, 75, 100, 130, 160, 185, 200]);
  a.schedule.forEach((c, i) => assert.equal(eligibleAt(a, i + 1).length, c));
  for (const s of a.submissions) {
    const t = a.meta[s.id].arrivalTurn;
    assert.ok(t >= 1 && t <= 8);
    assert.ok(eligibleAt(a, t).includes(s) && (t === 1 || !eligibleAt(a, t - 1).includes(s)));
  }
  // both sides keep receiving submissions across the debate
  for (const side of ["A", "B"]) assert.ok(a.submissions.filter((s) => s.side === side && a.meta[s.id].arrivalTurn >= 5).length >= 20);
});

test("side data stays separable: no text of one side is identical to or contained in a text of the other side", () => {
  for (const seed of [1, 2, 3, 99]) {
    const a = make(seed);
    const A = a.submissions.filter((s) => s.side === "A").map((s) => s.text.toLowerCase());
    const B = a.submissions.filter((s) => s.side === "B").map((s) => s.text.toLowerCase());
    for (const x of A) for (const y of B) assert.ok(!y.includes(x) && !x.includes(y), `${x} / ${y}`);
  }
});

test("deterministic for a seed, different for another seed, built from the generated case and never from a prepared scenario", () => {
  assert.deepEqual(make(5), make(5));
  assert.notDeepEqual(make(5).submissions.map((s) => s.text), make(6).submissions.map((s) => s.text));
  const a = make();
  const mentioning = a.submissions.filter((s) => ev.some((e) => s.text.includes(e.split(" ").slice(0, 5).join(" ")))).length;
  assert.ok(mentioning >= 100, `only ${mentioning} submissions quote the generated evidence`);
  for (const c of PREPARED_CASES) for (const e of c.evidence) for (const s of a.submissions) assert.ok(!s.text.includes(e.slice(0, 25)));
});

test("the exact counts hold even for the shortest allowed case (three evidence items)", () => {
  const a = make(4, ev.slice(0, 3));
  assert.equal(a.submissions.length, 200);
  assert.equal(a.submissions.filter((s) => s.side === "A").length, 100);
  assert.equal(new Set(a.submissions.map((s) => s.playerId)).size, 200);
});

test("only the benchmark audience size and a valid schedule are accepted", () => {
  assert.throws(() => buildAudience({ seed: 1, evidence: ev, interpretationA: "a a a a", interpretationB: "b b b b", size: 100 }));
  assert.throws(() => buildAudience({ seed: 1, evidence: ev, interpretationA: "a a a a", interpretationB: "b b b b", schedule: [10, 20, 30, 40, 50, 60, 70, 150] }));
});
