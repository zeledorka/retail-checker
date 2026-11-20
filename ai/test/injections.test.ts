import { test } from "node:test";
import assert from "node:assert/strict";
import { selectInjections, sanitizeInjection } from "../src/injections";
import type { AudienceInjection } from "../src/types";

const inj = (id: string, side: "A" | "B", window: 1 | 2, text: string, t: number, playerId?: string): AudienceInjection => ({
  id, side, window, text, submittedAt: t, playerId,
});
const limits = { maxPerAgent: 2, maxChars: 20 };

test("filters by side and window, earliest first, capped", () => {
  const all = [
    inj("3", "A", 1, "third", 30), inj("1", "A", 1, "first", 10), inj("2", "A", 1, "second", 20),
    inj("b", "B", 1, "for B", 5), inj("w2", "A", 2, "window two", 1),
  ];
  assert.deepEqual(selectInjections(all, "A", 1, limits).map((s) => s.id), ["1", "2"]);
  assert.deepEqual(selectInjections(all, "B", 1, limits).map((s) => s.id), ["b"]);
  assert.deepEqual(selectInjections(all, "A", 2, limits).map((s) => s.id), ["w2"]);
});

test("deterministic regardless of input order; ties broken by id", () => {
  const a = [inj("y", "A", 1, "one", 10), inj("x", "A", 1, "two", 10), inj("z", "A", 1, "three", 10)];
  const r1 = selectInjections(a, "A", 1, limits).map((s) => s.id);
  const r2 = selectInjections([...a].reverse(), "A", 1, limits).map((s) => s.id);
  assert.deepEqual(r1, ["x", "y"]);
  assert.deepEqual(r1, r2);
});

test("dedupes text and players, skips empty, truncates long text", () => {
  const all = [
    inj("1", "A", 1, "  Same  ", 1, "p1"), inj("2", "A", 1, "same", 2, "p2"),
    inj("3", "A", 1, "other from p1", 3, "p1"), inj("4", "A", 1, "   ", 4, "p3"),
    inj("5", "A", 1, "x".repeat(100), 5, "p4"),
  ];
  const out = selectInjections(all, "A", 1, limits);
  assert.deepEqual(out.map((s) => s.id), ["1", "5"]);
  assert.equal(out[1].text.length, 21); // 20 chars + ellipsis
});

test("sanitize strips control characters and collapses whitespace", () => {
  assert.equal(sanitizeInjection("a\u0000b\n\n c‮d", 100), "a b c d");
});
