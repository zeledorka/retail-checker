import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/benchmark-opinions.ts", ...args], { cwd: new URL("..", import.meta.url), env: { ...process.env, ANTHROPIC_API_KEY: "" }, encoding: "utf8" });

test("the live opinion benchmark makes no request without --approved and prints a six-request plan", () => {
  const out = run();
  assert.match(out, /6 paid requests max/);
  assert.match(out, /NOT RUN: no --approved flag/);
});

test("the checker re-check is a separate opt-in that raises the cap to eight and is still inert without --approved", () => {
  const out = run("--approve-recheck");
  assert.match(out, /8 paid requests max/);
  assert.match(out, /NOT RUN/);
});

test("approval without an API key stops before any request", () => {
  assert.throws(() => run("--approved"), /ANTHROPIC_API_KEY is not set/);
});
