import { test } from "node:test";
import assert from "node:assert/strict";
import { selectInjections, sanitizeInjection } from "../src/injections";
import type { AudienceInjection, Side } from "../src/types";

const inj = (id: string, side: Side, window: 1 | 2, text: string, t: number | string, playerId?: string): AudienceInjection => ({
  id, side, window, text, submittedAt: t, playerId,
});
const ids = (r: { id: string }[]) => r.map((s) => s.id);
const two = { maxPerAgent: 2, maxChars: 20 };
const three = { maxPerAgent: 3, maxChars: 200 };
/** n submissions s0..s(n-1) from distinct players, submitted at times 0..n-1. */
const burst = (n: number, side: Side = "A") => Array.from({ length: n }, (_, k) => inj(`s${k}`, side, 1, `suggestion ${k}`, k, `p${k}`));

test("filters by side and window; with 2 slots takes the newest 2, returned oldest to newest", () => {
  const all = [
    inj("3", "A", 1, "third", 30), inj("1", "A", 1, "first", 10), inj("2", "A", 1, "second", 20),
    inj("b", "B", 1, "for B", 5), inj("w2", "A", 2, "window two", 1),
  ];
  assert.deepEqual(ids(selectInjections(all, "A", 1, two)), ["2", "3"]);
  assert.deepEqual(ids(selectInjections(all, "B", 1, two)), ["b"]);
  assert.deepEqual(ids(selectInjections(all, "A", 2, two)), ["w2"]);
});

test("deterministic regardless of input order; ties broken by id", () => {
  const a = [inj("y", "A", 1, "one", 10), inj("x", "A", 1, "two", 10), inj("z", "A", 1, "three", 10)];
  const r1 = ids(selectInjections(a, "A", 1, two));
  assert.deepEqual(r1, ["x", "y"]);
  assert.deepEqual(r1, ids(selectInjections([...a].reverse(), "A", 1, two)));
});

test("burst of 200: bounded to 3 = two newest + the oldest waiting", () => {
  const out = selectInjections(burst(200), "A", undefined, three);
  assert.deepEqual(ids(out), ["s0", "s198", "s199"]);
});

test("recency: a fresh submission after many old ones is selected", () => {
  const all = [...burst(50), inj("fresh", "A", 1, "reacts to the latest argument", 1000, "pf")];
  assert.ok(ids(selectInjections(all, "A", undefined, three)).includes("fresh"));
});

test("fairness: the oldest waiting submission gets the older slot, and the next oldest after it is consumed", () => {
  const all = burst(10);
  assert.ok(ids(selectInjections(all, "A", undefined, three)).includes("s0"));
  const next = selectInjections(all, "A", undefined, three, new Set(["s0", "s8", "s9"]));
  assert.deepEqual(ids(next), ["s1", "s6", "s7"]);
});

test("fills available slots when fewer qualify; middle entries wait", () => {
  assert.deepEqual(ids(selectInjections(burst(2), "A", undefined, three)), ["s0", "s1"]);
  assert.deepEqual(ids(selectInjections(burst(4), "A", undefined, three)), ["s0", "s2", "s3"]);
  assert.deepEqual(ids(selectInjections(burst(1), "A", undefined, three)), ["s0"]);
});

test("consumed IDs are never selected again", () => {
  const all = burst(6);
  const used = new Set(ids(selectInjections(all, "A", undefined, three)));
  const again = ids(selectInjections(all, "A", undefined, three, used));
  assert.ok(again.length > 0 && again.every((id) => !used.has(id)));
  assert.deepEqual(selectInjections(all, "A", undefined, three, new Set(all.map((a) => a.id))), []);
});

test("side isolation", () => {
  const all = [...burst(5, "A"), ...burst(5, "B").map((b) => ({ ...b, id: "b" + b.id, playerId: "b" + b.playerId }))];
  assert.ok(ids(selectInjections(all, "A", undefined, three)).every((id) => id.startsWith("s")));
  assert.ok(ids(selectInjections(all, "B", undefined, three)).every((id) => id.startsWith("bs")));
});

test("one submission per player (newest wins); duplicate texts removed (newest wins)", () => {
  const spam = Array.from({ length: 5 }, (_, k) => inj(`m${k}`, "A", 1, `message ${k}`, k, "same-player"));
  assert.deepEqual(ids(selectInjections(spam, "A", undefined, three)), ["m4"]);
  const dup = [inj("1", "A", 1, "  Same  ", 1, "p1"), inj("2", "A", 1, "same", 2, "p2")];
  assert.deepEqual(ids(selectInjections(dup, "A", undefined, three)), ["2"]);
});

test("skips blank text, truncates long text, unparseable timestamps count as oldest", () => {
  const all = [inj("1", "A", 1, "x".repeat(100), 5, "p1"), inj("2", "A", 1, "   ", 6, "p2"), inj("3", "A", 1, "other", 4, "p3")];
  const out = selectInjections(all, "A", 1, two);
  assert.deepEqual(ids(out), ["3", "1"]);
  assert.equal(out[1].text.length, 21); // 20 chars + ellipsis
  const old = [inj("g", "A", 1, "bad timestamp", "garbage", "pg"), ...burst(5).map((b) => ({ ...b, submittedAt: Number(b.submittedAt) + 10 }))];
  assert.ok(ids(selectInjections(old, "A", undefined, three)).includes("g")); // takes the older slot, never a recent one
});

test("does not mutate its input", () => {
  const all = [inj("b", "A", 1, "two", 2), inj("a", "A", 1, "one", 1)];
  selectInjections(all, "A", 1, three);
  assert.deepEqual(ids(all), ["b", "a"]);
});

test("sanitize strips control characters and collapses whitespace", () => {
  assert.equal(sanitizeInjection("a\u0000b\n\n c‮d", 100), "a b c d");
});
