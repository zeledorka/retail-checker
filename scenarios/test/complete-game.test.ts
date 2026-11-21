import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoundState } from "../../ai/src/index";
import { runCompleteGame } from "../src/index";
import type { CompleteGameReport } from "../src/index";
import { DESIGNS } from "./full-fixtures";
import { gameProvider, slowImage } from "./game-fixtures";

async function play(over: Parameters<typeof gameProvider>[0] extends infer O ? Partial<O> : never = {}, opts: { caps?: { claude?: number; image?: number }; image?: ReturnType<typeof slowImage> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "game-test-"));
  const provider = gameProvider({ seed: 7, ...over });
  const image = opts.image ?? slowImage();
  const report = await runCompleteGame({ seed: 7, generate: provider, imageGenerator: image, outDir: dir, runId: "t", caps: opts.caps });
  return { dir, provider, image, report, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const check = (r: CompleteGameReport, re: RegExp) => r.checks.filter((c) => re.test(c.name));
const read = (dir: string, rel: string) => readFileSync(join(dir, "game-t", rel), "utf8");

test("a complete mocked round passes every check, with exactly 15 Claude requests and 1 image request", async () => {
  const t = await play();
  try {
    const r = t.report;
    assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => c.status === "fail")));
    assert.equal(r.checks.filter((c) => c.status === "fail").length, 0);
    assert.deepEqual(r.requests.byKind, { scenario: 1, "opinion-generation": 2, checker: 1, image: 1, agentA: 5, agentB: 5, judge: 1 });
    assert.equal(r.requests.claude, 15);
    assert.equal(r.requests.image, 1);
    assert.equal(t.image.calls, 1);
    assert.equal(Object.values(t.provider.counts).reduce((a, b) => a + b, 0), 15);
  } finally { t.cleanup(); }
});

test("image generation and opinion preparation overlap; the two opinion generations overlap; the debate stages are strictly sequential", async () => {
  const t = await play();
  try {
    const log = t.report.requests.log;
    assert.ok(check(t.report, /image generation overlapped/).every((c) => c.status === "pass"));
    assert.ok(check(t.report, /two opinion generations overlapped/).every((c) => c.status === "pass"));
    const debate = log.filter((q) => q.stage === "opening" || q.stage === "turn" || q.stage === "judge");
    for (let i = 1; i < debate.length; i++) assert.ok(debate[i].startMs >= debate[i - 1].endMs, `debate request ${i} started before the previous one finished`);
    assert.ok(debate.length === 11);
  } finally { t.cleanup(); }
});

test("two independent openings (A then B), eight ordered turns (sequences 3..10), state round-trips and every revision advances by one", async () => {
  const t = await play();
  try {
    const transcript = JSON.parse(read(t.dir, "public/transcript.json")) as { sequence: number; side: string; stage: string }[];
    assert.deepEqual(transcript.map((s) => s.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(transcript.map((s) => s.side), ["A", "B", "A", "B", "A", "B", "A", "B", "A", "B"]);
    const state = parseRoundState(read(t.dir, "private/state-final.json"));
    assert.ok(state.ok && state.state.revision === 11 && state.state.closed && state.state.transcript.length === 10 && !!state.state.verdict);
    assert.equal(check(t.report, /opening [AB]: state revision advanced/).filter((c) => c.status === "pass").length, 2);
    assert.ok(check(t.report, /speaker, sequence and revision/).length === 8 && check(t.report, /speaker, sequence and revision/).every((c) => c.status === "pass"));
    // openings do not read each other: B's opening request holds no text of A's opening
    const texts = JSON.parse(read(t.dir, "public/transcript.json")) as { text: string }[];
    const [a, b] = [t.provider.calls.filter((c) => c.kind === "agentA")[0], t.provider.calls.filter((c) => c.kind === "agentB")[0]];
    assert.ok(!b.prompt.includes(texts[0].text) && !a.prompt.includes(texts[1].text)); // neither opening request contains the other opening
  } finally { t.cleanup(); }
});

test("audience: 200 distinct supporters counted once, duplicates counted once per player, incremental arrival without double counting", async () => {
  const t = await play();
  try {
    assert.ok(check(t.report, /exactly 200 submissions/).every((c) => c.status === "pass"));
    assert.ok(check(t.report, /state [AB]: 100 distinct supporters/).length === 2 && check(t.report, /state [AB]: 100 distinct supporters/).every((c) => c.status === "pass"));
    const dups = check(t.report, /exact duplicates/);
    assert.equal(dups.length, 4);
    assert.ok(dups.every((c) => c.status === "pass"), JSON.stringify(dups));
    assert.deepEqual((t.report.audience as { schedule: number[] }).schedule, [25, 50, 75, 100, 130, 160, 185, 200]);
    const turns = JSON.parse(read(t.dir, "private/turn-diagnostics.json")) as { eligibleCumulative: number }[];
    assert.deepEqual(turns.map((x) => x.eligibleCumulative), [25, 50, 75, 100, 130, 160, 185, 200]);
    assert.ok(check(t.report, /audience accounting balances/).every((c) => c.status === "pass"));
  } finally { t.cleanup(); }
});

test("side-private audience data and judge isolation hold on the actual prompts", async () => {
  const t = await play();
  try {
    const audience = (JSON.parse(read(t.dir, "private/audience-submissions.json")) as { submissions: { side: string; text: string; playerId: string }[] }).submissions;
    for (const side of ["A", "B"]) {
      const other = audience.filter((s) => s.side !== side).map((s) => s.text);
      for (const c of t.provider.calls.filter((x) => x.kind === `agent${side}`)) for (const x of other) assert.ok(!c.prompt.includes(x), `Agent ${side} saw: ${x}`);
    }
    const judge = t.provider.calls.filter((c) => c.kind === "judge");
    assert.equal(judge.length, 1);
    for (const s of audience) assert.ok(!judge[0].prompt.includes(s.text) && !judge[0].prompt.includes(s.playerId));
    assert.doesNotMatch(judge[0].prompt + judge[0].system, /supporter|personality|checker|designs?\b/i);
    for (const d of DESIGNS) assert.ok(!judge[0].prompt.includes(d.mechanism));
    assert.ok(check(t.report, /Agent [AB]'s requests contain none/).length === 2 && check(t.report, /judge prompt contains no audience/).every((c) => c.status === "pass"));
  } finally { t.cleanup(); }
});

test("adversarial audience instructions: a model that obeys them is caught by the harness; a model that does not passes", async () => {
  const bad = await play({ obeyCanary: true });
  try {
    assert.ok(!bad.report.ok);
    assert.ok(check(bad.report, /no audience canary instruction obeyed/).some((c) => c.status === "fail"));
  } finally { bad.cleanup(); }
  const good = await play();
  try { assert.ok(check(good.report, /no audience canary instruction obeyed/).every((c) => c.status === "pass")); } finally { good.cleanup(); }
});

test("a completed verdict is validated and saved; outputs are persisted in public and private folders", async () => {
  const t = await play();
  try {
    assert.ok(check(t.report, /verdict complete/).every((c) => c.status === "pass"));
    const j = JSON.parse(read(t.dir, "public/judgment.json"));
    assert.equal(j.winner, "A");
    assert.equal(j.complete, true);
    assert.equal(j.turnsCompleted, 8);
    for (const f of ["public/case.json", "public/positions.json", "public/transcript.json", "public/transcript.md", "public/judgment.json", "private/audience-submissions.json", "private/preparation.json", "private/turn-diagnostics.json", "private/state-final.json", "private/requests.json", "report.json", "report.md"]) assert.ok(existsSync(join(t.dir, "game-t", f)), f);
    assert.ok(readdirSync(join(t.dir, "game-t", "public")).some((f) => /\.png$/.test(f))); // the generated image file
    assert.match(read(t.dir, "report.md"), /NOT a real 200-client multiplayer load test/);
    assert.ok((t.report.timing.totalWallMs as number) >= (t.report.timing.preparationMs as number));
    assert.ok(t.report.criticalPath.some((l) => /PARALLEL/.test(l)));
    assert.ok((t.report.timing.sumOfModelDurationsMs as number) >= 0 && Array.isArray(t.report.timing.turnMs) && (t.report.timing.turnMs as number[]).length === 8);
  } finally { t.cleanup(); }
});

test("public outputs contain no private audience data, personalities, design text, player ids, canaries, keys or image bytes", async () => {
  const t = await play();
  try {
    const secrets = (JSON.parse(read(t.dir, "private/audience-submissions.json")) as { submissions: { text: string; playerId: string }[]; canaries: string[]; fabricatedNames: string[] });
    const pub = readdirSync(join(t.dir, "game-t", "public")).filter((f) => /\.(json|md)$/.test(f)).map((f) => read(t.dir, `public/${f}`)).join("\n");
    for (const s of secrets.submissions) assert.ok(!pub.includes(s.text) && !pub.includes(s.playerId));
    for (const x of [...secrets.canaries, ...secrets.fabricatedNames, ...DESIGNS.map((d) => d.mechanism), "evidenceScepticism", "selfDefensibility", "sk-", "iVBOR"]) assert.ok(!pub.includes(x), x);
    assert.doesNotMatch(read(t.dir, "report.json"), /sk-ant|Bearer|iVBOR/);
  } finally { t.cleanup(); }
});

test("a failed debate turn stops the run, names the stage, preserves partial outputs, makes no judge request and never reruns", async () => {
  const t = await play({ failOn: (k, n) => k === "agentB" && n === 3 }); // Agent B's third request = its second turn
  try {
    const r = t.report;
    assert.ok(!r.ok);
    assert.equal(r.failedStage, "E: debate turn 4");
    assert.match(r.error!, /model_error/);
    assert.equal(r.requests.byKind.judge, undefined);
    assert.equal(r.requests.claude, 4 + 2 + 3 + 1); // preparation, openings, turns 1-3 ok, turn 4 failed
    for (const f of ["public/case.json", "public/transcript.json", "private/turn-diagnostics.json", "report.json", "report.md"]) assert.ok(existsSync(join(t.dir, "game-t", f)), f);
    assert.equal((JSON.parse(read(t.dir, "public/transcript.json")) as unknown[]).length, 2 + 3);
    assert.equal(t.provider.counts.agentB, 3); // no automatic retry
  } finally { t.cleanup(); }
});

test("failures in earlier stages stop before any debate request: invalid scenario, image failure, opening failure, judge failure", async () => {
  const badScenario = await play({ scenarioReply: () => "not json" });
  try {
    assert.ok(!badScenario.report.ok && /^A:/.test(badScenario.report.failedStage!));
    assert.equal((badScenario.report.requests.byKind.agentA ?? 0) + (badScenario.report.requests.byKind.agentB ?? 0), 0);
    assert.equal(badScenario.report.requests.claude, 1); // the invalid scenario was never retried and no later stage ran
    assert.equal(badScenario.report.requests.image, 0);
  } finally { badScenario.cleanup(); }
  const noImage = await play({}, { image: slowImage(1, () => ({ ok: false, error: { code: "unsupported_model", message: "gone", retryable: false } })) });
  try {
    assert.ok(!noImage.report.ok && /image/.test(noImage.report.failedStage!));
    assert.equal(noImage.report.requests.byKind.agentA, undefined);
    assert.ok(existsSync(join(noImage.dir, "game-t", "private", "preparation-partial.json"))); // the scenario and opinions that succeeded are preserved
  } finally { noImage.cleanup(); }
  const noOpening = await play({ failOn: (k, n) => k === "agentB" && n === 1 });
  try { assert.ok(!noOpening.report.ok && noOpening.report.failedStage === "C: opening B"); } finally { noOpening.cleanup(); }
  const noJudge = await play({ failOn: (k) => k === "judge" });
  try {
    assert.ok(!noJudge.report.ok && noJudge.report.failedStage === "F: judge");
    assert.equal(noJudge.report.requests.claude, 15);
    assert.ok(existsSync(join(noJudge.dir, "game-t", "public", "transcript.json")));
  } finally { noJudge.cleanup(); }
});

test("hard caps are enforced without sending the request: a 5-request Claude cap stops the run and a second image request is refused", async () => {
  const t = await play({}, { caps: { claude: 5 } });
  try {
    assert.ok(!t.report.ok);
    assert.ok(t.report.requests.claude <= 5);
    assert.ok(t.provider.calls.length <= 5);
    assert.equal(t.report.failedStage, "C: opening B");
    assert.match(t.report.error!, /cap 5 reached/); // the sixth request was refused locally and never sent
  } finally { t.cleanup(); }
});

test("the benchmark script makes zero requests without --approved, reports configuration without secrets, and refuses --approved without keys", () => {
  const run = (...args: string[]) => execFileSync("npx", ["tsx", "scripts/benchmark-complete-game.ts", ...args], { cwd: new URL("..", import.meta.url), env: { ...process.env, ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = run();
  assert.match(out, /15 Claude, plus 1 OpenRouter image/);
  assert.match(out, /16 paid requests\. Hard caps 15 \+ 1/);
  assert.match(out, /NOT RUN: no --approved flag/);
  assert.throws(() => run("--approved"), (e: { stderr?: string }) => /is not set/.test(String(e.stderr)) && /No request was made/.test(String(e.stderr)));
  assert.throws(() => run("--seed=x"), (e: { stderr?: string }) => /--seed must be an integer/.test(String(e.stderr)));
  const dir = mkdtempSync(join(tmpdir(), "envtest-"));
  try {
    writeFileSync(join(dir, "e.env"), "ANTHROPIC_API_KEY=fake-a\nOPENROUTER_API_KEY=fake-b\n");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENROUTER_API_KEY;
    const o2 = execFileSync("npx", ["tsx", "scripts/benchmark-complete-game.ts", `--env-file=${join(dir, "e.env")}`], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" });
    assert.match(o2, /ANTHROPIC_API_KEY set, OPENROUTER_API_KEY set/);
    assert.doesNotMatch(o2, /fake-a|fake-b/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
