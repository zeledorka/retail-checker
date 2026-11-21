import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/benchmark-full-generation.ts", ...args], { cwd: new URL("..", import.meta.url), env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("the full benchmark is a dry run by default: it prints a five-request plan and makes no request", () => {
  const out = run();
  assert.match(out, /Total 5 paid requests\. No retries, no fallback/);
  assert.match(out, /1 scenario \+ 2 opinion generations \+ 1 checker = 4 requests/);
  assert.match(out, /google\/gemini-3\.1-flash-lite-image/);
  assert.match(out, /NOT RUN: no --approved flag/);
  assert.doesNotMatch(out, /sk-|Bearer/);
});

test("--approved without both keys stops before any request and never prints a key", () => {
  assert.throws(() => run("--approved"), (e: { stderr?: string }) => /ANTHROPIC_API_KEY is not set/.test(String(e.stderr)) && /No request was made/.test(String(e.stderr)));
});

test("an invalid seed is refused before anything else", () => {
  assert.throws(() => run("--seed=abc"), (e: { stderr?: string }) => /--seed must be an integer/.test(String(e.stderr)));
});

test("--env-file is loaded before the plan reports the environment, so keys from the file show as set (reporting-order regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "envtest-"));
  try {
    const file = join(dir, "fake.env");
    writeFileSync(file, "ANTHROPIC_API_KEY=fake-a\nOPENROUTER_API_KEY=fake-b\n");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENROUTER_API_KEY;
    const out = execFileSync("npx", ["tsx", "scripts/benchmark-full-generation.ts", `--env-file=${file}`], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" });
    assert.match(out, /ANTHROPIC_API_KEY set, OPENROUTER_API_KEY set/);
    assert.match(out, /NOT RUN/);
    assert.doesNotMatch(out, /fake-a|fake-b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
