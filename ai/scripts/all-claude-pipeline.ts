// End-to-end pipeline for the manual all-Claude benchmark. The model call function is injected so the
// control flow can be checked with mocks; test-all-claude.ts supplies the real one. Test code only.
import { createDebateEngine, generateText } from "../src/index";
import type { AudienceInjection, EngineConfig, GenerateTextFn, JudgeResult, Scenario, Side, TranscriptEntry } from "../src/types";
import { COMPARE_SYSTEM, OPINION_SYSTEM, comparePrompt, opinionPrompt, parseComparison, parseOpinion, type Opinion } from "./opinions";
import { describeMeta, makeTracker, wordCount } from "./lib";

export type BaseScenario = Omit<Scenario, "interpretationA" | "interpretationB">;
/** A simulated audience submission, eligible from generated turn `arrives` onwards (1 = before the first turn). */
export type Submission = AudienceInjection & { arrives: number; kind: string };
/** A candidate scenario together with the simulated audience for it. */
export type Candidate = { scenario: BaseScenario; submissions: Submission[] };
/** --debate-only: opposing interpretations written by the test author, NOT produced by the agents. */
export type Predefined = { interpretationA: string; interpretationB: string };
export type PipelineOptions = {
  maxTurns: number;
  budgetMs: number; // debate budget: starts with the openings, ends after the last turn
  turnTimeoutMs: number;
  minTurnMs: number; // never start a turn with less than this left
  maxWords: number;
  judgeTargetMs: number;
};
export type Attempt = { title: string; outcome: "agreed" | "disagreed" | "error"; opinionsMs: number; compareMs: number };
export type PipelineResult = {
  /** agree = every candidate produced matching opinions; debated = full debate judged; failed = a call failed. */
  outcome: "agree" | "debated" | "failed";
  mode: "independent" | "predefined";
  chosenTitle?: string;
  attempts: Attempt[];
  failures: string[];
  requests: number;
  timings: { opinionsMs: number; compareMs: number; openingsMs: number; turnsMs: number; debateMs: number; judgeMs: number; totalMs: number };
  turnsDone: number;
  transcript: TranscriptEntry[];
  verdict?: JudgeResult;
};

const line = (n = 72) => "=".repeat(n);
const SIDES: Side[] = ["A", "B"];

export async function runAllClaude(deps: {
  config: EngineConfig;
  candidates: Candidate[];
  predefined?: Predefined;
  options: PipelineOptions;
  log: (s: string) => void;
  generate?: GenerateTextFn;
}): Promise<PipelineResult> {
  const { config, candidates, predefined, options, log } = deps;
  const generate = deps.generate ?? generateText;
  const tracker = makeTracker();
  const engine = createDebateEngine(config, { generate, onModelCall: tracker.onModelCall });
  const roundId = `all-claude-${Date.now()}`;
  const failures: string[] = [];
  const attempts: Attempt[] = [];
  const t0 = Date.now();
  const timings = { opinionsMs: 0, compareMs: 0, openingsMs: 0, turnsMs: 0, debateMs: 0, judgeMs: 0, totalMs: 0 };
  const transcript: TranscriptEntry[] = [];
  const mode: PipelineResult["mode"] = predefined ? "predefined" : "independent";
  let turnsDone = 0;
  let chosen: Candidate | undefined;

  const finish = (outcome: PipelineResult["outcome"], verdict?: JudgeResult): PipelineResult => {
    timings.totalMs = Date.now() - t0;
    log(`\n${line()}\nSUMMARY (${outcome.toUpperCase()}, ${mode} opinions)`);
    for (const [i, a] of attempts.entries())
      log(`  Candidate ${i + 1}: ${a.title} -> ${a.outcome} (opinions ${a.opinionsMs} ms, agreement check ${a.compareMs} ms)`);
    log(`Phases: opinions ${timings.opinionsMs} ms | agreement checks ${timings.compareMs} ms | openings ${timings.openingsMs} ms | sequential turns ${timings.turnsMs} ms (${turnsDone} turns) | judge ${timings.judgeMs} ms`);
    log(`Debate-only time (openings + turns): ${(timings.debateMs / 1000).toFixed(1)}s of ${options.budgetMs / 1000}s budget | End-to-end wall-clock: ${(timings.totalMs / 1000).toFixed(1)}s`);
    log(`Total AI ${tracker.summary()}`);
    log(failures.length ? `FAILURES / TIMEOUTS:\n  ${failures.join("\n  ")}` : "Failures/timeouts: none");
    return { outcome, mode, chosenTitle: chosen?.scenario.title, attempts, failures, requests: tracker.t.requests, timings, turnsDone, transcript, verdict };
  };

  let interpretationA = "";
  let interpretationB = "";

  if (predefined) {
    chosen = candidates[0];
    interpretationA = predefined.interpretationA;
    interpretationB = predefined.interpretationB;
    log(`${line()}\nDEBATE-ONLY MODE: the interpretations below are PREDEFINED by the test author.\nThey were NOT independently generated, so no opinion-formation or agreement check is run.`);
  } else {
    // ---- Phases 1-2, repeated per candidate until two independent opinions meaningfully differ
    for (const [k, cand] of candidates.entries()) {
      const base = cand.scenario;
      log(`${line()}\nCANDIDATE ${k + 1}/${candidates.length}: ${base.title}\n${base.description}\nObservations:\n${base.evidence.map((e) => `  - ${e}`).join("\n")}`);
      log(`\nPHASE 1: INDEPENDENT OPINIONS (parallel; identical scenario; neither agent sees the other)`);
      const attempt: Attempt = { title: base.title, outcome: "error", opinionsMs: 0, compareMs: 0 };
      attempts.push(attempt);

      const p1 = Date.now();
      const outcomes = await Promise.all(
        SIDES.map((s) => generate(s === "A" ? config.agentA : config.agentB, { system: OPINION_SYSTEM, prompt: opinionPrompt(base.description, base.evidence) })),
      );
      attempt.opinionsMs = Date.now() - p1;
      timings.opinionsMs += attempt.opinionsMs;
      const opinions: Partial<Record<Side, Opinion>> = {};
      SIDES.forEach((s, i) => {
        const o = outcomes[i];
        tracker.record(o);
        log(`\n  Agent ${s}:`);
        if (!o.ok) {
          failures.push(`opinion Agent ${s} (${base.title}): [${o.error.kind}] ${o.error.message}`);
          log(`    ERROR [${o.error.kind}] ${o.error.message}`);
          return;
        }
        const p = parseOpinion(o.result.text);
        if (!p.ok) {
          failures.push(`opinion Agent ${s} (${base.title}): ${p.reason}`);
          log(`    INVALID OUTPUT: ${p.reason}\n    Raw: ${o.result.text}`);
          return;
        }
        opinions[s] = p.value;
        log(`    Interpretation: ${p.value.interpretation}\n    Reasoning:      ${p.value.reasoning}\n    Confidence:     ${p.value.confidence}`);
        log(`    (${describeMeta(o.result)})`);
      });
      log(`  Opinion phase: ${attempt.opinionsMs} ms`);
      if (!opinions.A || !opinions.B) return finish("failed");

      log(`\nPHASE 2: AGREEMENT CHECK`);
      const p2 = Date.now();
      const cmp = await generate(config.judge, { system: COMPARE_SYSTEM, prompt: comparePrompt(opinions.A.interpretation, opinions.B.interpretation) });
      attempt.compareMs = Date.now() - p2;
      timings.compareMs += attempt.compareMs;
      tracker.record(cmp);
      if (!cmp.ok) {
        failures.push(`agreement check (${base.title}): [${cmp.error.kind}] ${cmp.error.message}`);
        log(`  ERROR [${cmp.error.kind}] ${cmp.error.message}`);
        return finish("failed");
      }
      log(`  (${describeMeta(cmp.result)})`);
      const c = parseComparison(cmp.result.text);
      if (!c.ok) {
        failures.push(`agreement check (${base.title}): ${c.reason}`);
        log(`  INVALID OUTPUT: ${c.reason}\n  Raw: ${cmp.result.text}`);
        return finish("failed");
      }
      log(`  Meaningful disagreement: ${c.disagree ? "YES" : "NO"} — ${c.reason}`);
      if (!c.disagree) {
        attempt.outcome = "agreed";
        log(k + 1 < candidates.length ? "\n  Same conclusion reached independently. Opinions left untouched; trying the next candidate scenario." : "\n  Same conclusion reached independently, and no candidates are left.");
        continue;
      }
      attempt.outcome = "disagreed";
      chosen = cand;
      interpretationA = opinions.A.interpretation;
      interpretationB = opinions.B.interpretation;
      break;
    }
    if (!chosen) {
      log(`\n${line()}\nNo meaningful disagreement in any of the ${candidates.length} candidate scenarios, so no debate was run.\nNothing was reworded or assigned to manufacture one. Try --debate-only to exercise the debate and judge.`);
      return finish("agree");
    }
  }
  if (!chosen) return finish("failed"); // unreachable unless `candidates` is empty

  // ---- Phase 3: lock the interpretations
  const base = chosen.scenario;
  const submissions = chosen.submissions;
  const scenario: Scenario = { ...base, interpretationA, interpretationB };
  log(`\n${line()}\nPHASE 3: LOCKED INTERPRETATIONS for "${base.title}" (${predefined ? "PREDEFINED, not independently generated" : "independently generated"})\n  A: ${scenario.interpretationA}\n  B: ${scenario.interpretationB}`);
  log("\n  Audience schedule (eligible from generated turn N; side-private):");
  for (const s of submissions.filter((x) => x.kind !== "burst")) log(`    turn ${s.arrives}+ [${s.id}] -> Agent ${s.side}: ${s.text}`);
  const burst = submissions.filter((x) => x.kind === "burst");
  if (burst.length) log(`    plus a spam burst of ${burst.length} submissions from turn ${Math.min(...burst.map((x) => x.arrives))}`);

  // ---- Phase 4: openings (parallel) then sequential turns, inside one debate budget
  log(`\n${line()}\nPHASE 4: OPENINGS`);
  const debateStart = Date.now();
  const remainingMs = () => options.budgetMs - (Date.now() - debateStart);
  const open = await engine.generateOpeningArguments({ roundId, scenario, signal: AbortSignal.timeout(options.budgetMs) });
  timings.openingsMs = Date.now() - debateStart;
  for (const s of SIDES) {
    const a = open.arguments[s];
    if (a) log(`\n  Opening, Agent ${s} — ${wordCount(a.text)} words\n  ${a.text}\n  (${describeMeta(a.meta)})`);
  }
  if (!open.ok) {
    for (const [s, e] of Object.entries(open.errors)) failures.push(`opening Agent ${s}: [${e.kind}] ${e.message}`);
    timings.debateMs = Date.now() - debateStart;
    return finish("failed");
  }
  for (const s of SIDES) transcript.push({ stage: "opening", side: s, text: open.arguments[s].text });

  log(`\n${line()}\nPHASE 5: SEQUENTIAL TURNS (max ${options.maxTurns}, budget ${options.budgetMs / 1000}s)`);
  const consumed = new Set<string>();
  const latencies: number[] = [];
  const turnsStart = Date.now();
  let stop = `reached max turns (${options.maxTurns})`;
  for (let idx = 1; idx <= options.maxTurns; idx++) {
    const remaining = remainingMs();
    const avg = latencies.length ? latencies.reduce((x, y) => x + y, 0) / latencies.length : 0;
    const needed = Math.max(options.minTurnMs, avg * 1.25);
    if (remaining < needed) {
      stop = `budget: ${Math.max(0, Math.round(remaining))} ms left, next turn needs ~${Math.round(needed)} ms`;
      break;
    }
    const speaker: Side = idx % 2 === 1 ? "A" : "B";
    const res = await engine.generateNextTurn({
      roundId,
      speaker,
      scenario,
      transcript: [...transcript],
      injections: submissions.filter((s) => s.arrives <= idx), // immutable snapshot of what has arrived so far
      consumedInjectionIds: consumed,
      maxWords: options.maxWords,
      timeoutMs: Math.min(options.turnTimeoutMs, remaining),
    });
    if (!res.ok) {
      failures.push(`turn ${res.turn} (Agent ${speaker}): [${res.error.kind}] ${res.error.message}`);
      stop = `failure on turn ${res.turn} (${res.error.kind}); not retried`;
      log(`\n  Turn ${res.turn}, Agent ${speaker}: ERROR [${res.error.kind}] ${res.error.message}`);
      break;
    }
    const a = res.argument;
    a.injectionIdsUsed.forEach((id) => consumed.add(id));
    transcript.push({ stage: a.stage, side: a.side, text: a.text, turn: a.turn });
    latencies.push(a.meta.latencyMs);
    turnsDone++;
    const words = wordCount(a.text);
    log(`\n  Turn ${a.turn}, Agent ${a.side} at ${((Date.now() - debateStart) / 1000).toFixed(1)}s — ${words} words${words > options.maxWords ? ` (OVER LIMIT ${options.maxWords})` : ""}`);
    log(`  injections included: ${a.injectionIdsUsed.join(", ") || "none"}\n  ${a.text}\n  (${describeMeta(a.meta)})`);
  }
  timings.turnsMs = Date.now() - turnsStart;
  timings.debateMs = Date.now() - debateStart;
  log(`\n  Debate stopped: ${stop}`);

  // ---- Phase 6: independent judge (everything above has been awaited: nothing is in flight)
  log(`\n${line()}\nPHASE 6: INDEPENDENT JUDGE (${transcript.length} public arguments)`);
  const j0 = Date.now();
  const verdict = await engine.judgeDebate({ roundId, scenario, transcript });
  timings.judgeMs = Date.now() - j0;
  if (verdict.ok) {
    const v = verdict.verdict;
    log(`  Winner: Agent ${v.winner}\n  ${v.explanation}\n  Scores: ${JSON.stringify(v.scores)}\n  (${describeMeta(verdict.meta)})`);
    log(`  Judge latency: ${(timings.judgeMs / 1000).toFixed(1)}s (target ${options.judgeTargetMs / 1000}s${timings.judgeMs > options.judgeTargetMs ? " — OVER TARGET" : ""})`);
  } else {
    failures.push(`judge: [${verdict.error.kind}] ${verdict.error.message}`);
    log(`  ERROR [${verdict.error.kind}] ${verdict.error.message}`);
  }
  log(`  Injections included over the debate (${consumed.size}): ${[...consumed].join(", ") || "none"}`);
  return finish(verdict.ok ? "debated" : "failed", verdict);
}
