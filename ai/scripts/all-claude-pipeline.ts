// End-to-end pipeline for the manual all-Claude benchmark. The model call function is injected so the
// control flow can be checked with mocks; test-all-claude.ts supplies the real one. Test code only.
import { createDebateEngine, createThemeCoordinator, generateText } from "../src/index";
import { JUDGE_SYSTEM } from "../src/prompts";
import type { AudienceInjection, EngineConfig, GenerateTextFn, JudgeResult, Scenario, Side, TranscriptEntry } from "../src/types";
import { COMPARE_SYSTEM, OPINION_SYSTEM, comparePrompt, opinionPrompt, parseComparison, parseOpinion, type Opinion } from "./opinions";
import { describeMeta, makeTracker, wordCount } from "./lib";
import { auditGrouping } from "./grouping-audit";
import { DEFAULT_PRICES, estimateCost, priceFor, type Price } from "./pricing";
import type { WordLimitInfo } from "../src/wordlimit";

export type BaseScenario = Omit<Scenario, "interpretationA" | "interpretationB">;
/** A simulated audience submission, eligible from generated turn `arrives` onwards (1 = before the first turn). */
export type Submission = AudienceInjection & { arrives: number; kind: string };
/** A candidate scenario together with the simulated audience for it. */
export type Candidate = {
  scenario: BaseScenario;
  submissions: Submission[];
  /** Known categories per side, so the agent's grouping can be audited by player membership. Defaults to insurance/logbook. */
  audit?: { scored: Record<Side, string[]>; separate: Record<Side, string[]>; contradictory: Record<Side, string[]> };
};
/** --debate-only: opposing interpretations written by the test author, NOT produced by the agents. */
export type Predefined = { interpretationA: string; interpretationB: string };
export type PipelineOptions = {
  maxTurns: number;
  budgetMs: number; // debate budget: starts with the openings, ends after the last turn
  turnTimeoutMs: number;
  minTurnMs: number; // never start a turn with less than this left
  maxWords: number;
  judgeTargetMs: number;
  /** Model-specific USD per million tokens (default: DEFAULT_PRICES). Costs are ESTIMATES, not provider-confirmed charges. */
  prices?: Record<string, Price>;
  /** Judge even if a debate turn failed (debugging). Default: a failed debate is INCOMPLETE and is not judged. */
  judgePartial?: boolean;
};
export type Attempt = { title: string; outcome: "agreed" | "disagreed" | "error"; opinionsMs: number; compareMs: number };
export type PipelineResult = {
  /**
   * agree = every candidate produced matching opinions | debated = the debate ran and was judged | failed = a call before the
   * debate failed | incomplete = a debate turn failed: the round is NOT complete and (by default) was not judged.
   */
  outcome: "agree" | "debated" | "failed" | "incomplete";
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
const describeLimit = (w: WordLimitInfo) =>
  w.shortened
    ? `WORD LIMIT ${w.limit}: shortened ${w.originalWords} -> ${w.finalWords} words by ${w.method}${w.droppedSentences !== undefined ? ` (${w.droppedSentences} sentence(s) dropped)` : ""}${w.removed?.length ? ` (deleted only: "${w.removed.join('", "')}")` : ""}${w.lossy ? " (POTENTIALLY LOSSY, check meaning)" : ""} | central conclusion: ${w.conclusion === "kept" ? "kept" : w.conclusion === "possibly-lost" ? "POSSIBLY LOST" : "not identified (no recognisable conclusion marker)"}`
    : `word limit ${w.limit}: ${w.finalWords} words, not shortened`;
const SIDES: Side[] = ["A", "B"];

export async function runAllClaude(deps: {
  config: EngineConfig;
  candidates: Candidate[];
  predefined?: Predefined;
  options: PipelineOptions;
  log: (s: string) => void;
  generate?: GenerateTextFn;
  /** Persistent-theme mode: themes accumulate across turns; reconciliation runs in the background between turns. */
  persistent?: { waitMs: number };
}): Promise<PipelineResult> {
  const { config, candidates, predefined, options, log } = deps;
  const baseGenerate = deps.generate ?? generateText;
  const captured: { system: string; prompt: string }[] = []; // prompts actually sent, for the privacy checks
  const generate: GenerateTextFn = (cfg, req) => {
    captured.push({ system: req.system, prompt: req.prompt });
    return baseGenerate(cfg, req);
  };
  const turnLatencyByModel: { turn: number; side: Side; model: string; ms: number }[] = [];
  const limitStats: (WordLimitInfo & { label: string })[] = []; // every public argument's word-limit record
  const tracker = makeTracker();
  const themeTracker = makeTracker(); // semantic-grouping requests are reported separately from debating and judging
  const engine = createDebateEngine(config, { generate, onModelCall: (e) => (e.role === "themes" ? themeTracker : tracker).onModelCall(e) });
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
    if (outcome === "incomplete") log(`*** BENCHMARK INCOMPLETE: a debate turn failed after ${turnsDone} successful turn(s). This is NOT a completed round: nothing below is a result for the full 8-turn debate. ${verdict ? "The judge ran only because --judge-partial was given, on a partial transcript." : "The judge was not called."} ***`);
    for (const [i, a] of attempts.entries())
      log(`  Candidate ${i + 1}: ${a.title} -> ${a.outcome} (opinions ${a.opinionsMs} ms, agreement check ${a.compareMs} ms)`);
    log(`Phases: opinions ${timings.opinionsMs} ms | agreement checks ${timings.compareMs} ms | openings ${timings.openingsMs} ms | sequential turns ${timings.turnsMs} ms (${turnsDone} turns) | judge ${timings.judgeMs} ms`);
    log(`Debate-only time (openings + turns): ${(timings.debateMs / 1000).toFixed(1)}s of ${options.budgetMs / 1000}s budget | End-to-end wall-clock: ${(timings.totalMs / 1000).toFixed(1)}s`);
    log(`Debating + judging AI ${tracker.summary()}`);
    if (deps.persistent) log(`Separate semantic-grouping AI requests: ${themeTracker.t.requests}${themeTracker.t.requests ? ` | ${themeTracker.summary()}` : ""}`);
    const prices = options.prices ?? DEFAULT_PRICES;
    const cost = estimateCost([...tracker.calls, ...themeTracker.calls], prices);
    const usd = (n: number) => `$${n.toFixed(4)}`;
    log("PERFORMANCE BY ROLE (separate; the debate and the judge are different phases):");
    for (const g of ["debaters", "judge", "grouping"] as const) {
      const b = cost.byGroup[g];
      if (g === "grouping" && !b.requests) continue;
      log(`  ${g.padEnd(9)} requests ${b.requests} (ok ${b.requests - b.failed}, failed ${b.failed}) | tokens in/out ${b.inputTokens}/${b.outputTokens} | estimated ${usd(b.usd)}`);
    }
    for (const [m, b] of Object.entries(cost.byModel)) {
      const p = priceFor(m, prices);
      log(`  model ${m}: ${b.requests} request(s), tokens in/out ${b.inputTokens}/${b.outputTokens} at ${p ? `$${p.input} in / $${p.output} out per MTok` : "NO PRICE KNOWN (not costed)"} = ${usd(b.usd)}`);
    }
    const attempted = tracker.t.requests + themeTracker.t.requests;
    const failedReq = tracker.t.failed + themeTracker.t.failed;
    log(`MODEL REQUESTS: attempted ${attempted} | successful ${attempted - failedReq} | failed ${failedReq}${failedReq ? " (failed requests still count their reported tokens and estimated cost above)" : ""}`);
    log(`${outcome === "debated" ? "ESTIMATED TOTAL COST" : "PARTIAL USAGE COST (this run did not complete: it is NOT the cost of a completed round)"}: ${usd(cost.totalUsd)} (model-specific prices, computed from reported token counts; an estimate, not a provider-confirmed charge)${cost.unpriced.length ? ` | unpriced models: ${cost.unpriced.join(", ")}` : ""}`);
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
  if (deps.persistent) {
    const big = submissions.length > 100;
    const groups = new Map<string, number>();
    const key = (x: Submission) => (big ? `turn ${String(x.arrives).padStart(2)} | Agent ${x.side}` : `turn ${x.arrives} | Agent ${x.side} | ${x.kind}`);
    for (const x of submissions) groups.set(key(x), (groups.get(key(x)) ?? 0) + 1);
    for (const [k, n] of [...groups].sort()) log(`    ${k}: ${n} submissions`);
    log(`    total ${submissions.length} submissions from ${new Set(submissions.map((x) => x.playerId)).size} distinct players (A ${submissions.filter((x) => x.side === "A").length} / B ${submissions.filter((x) => x.side === "B").length}); players with more than one submission: ${submissions.length - new Set(submissions.map((x) => x.playerId)).size}`);
  } else for (const s of submissions.filter((x) => x.kind !== "burst")) log(`    turn ${s.arrives}+ [${s.id}] -> Agent ${s.side}: ${s.text}`);
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
    if (a) {
      log(`\n  Opening, Agent ${s} — ${wordCount(a.text)} words${a.wordLimit ? ` | ${describeLimit(a.wordLimit)}` : ""}\n  ${a.text}\n  (${describeMeta(a.meta)})`);
      if (a.wordLimit) limitStats.push({ label: `Opening ${s}`, ...a.wordLimit });
      if (a.wordLimit?.shortened && a.wordLimit.originalText) log(`  original (unbounded) model argument, for diagnosis: ${a.wordLimit.originalText}`);
    }
  }
  if (!open.ok) {
    for (const [s, e] of Object.entries(open.errors)) failures.push(`opening Agent ${s}: [${e.kind}] ${e.message}`);
    timings.debateMs = Date.now() - debateStart;
    return finish("failed");
  }
  for (const s of SIDES) transcript.push({ stage: "opening", side: s, text: open.arguments[s].text });

  log(`\n${line()}\nPHASE 5: SEQUENTIAL TURNS (max ${options.maxTurns}, budget ${options.budgetMs / 1000}s)`);
  const consumed = new Set<string>();
  const includedEver = new Set<string>();
  const totals = { duplicates: 0, invalid: 0, chars: 0, processingMs: 0 };
  const latencies: number[] = [];
  const P = deps.persistent;
  const auditSpec = chosen.audit ?? {
    scored: { A: ["insurance", "logbook"], B: ["insurance", "logbook"] },
    separate: { A: ["opposite", "fabricated", "injection", "irrelevant"], B: ["opposite", "fabricated", "injection", "irrelevant"] },
    contradictory: { A: ["opposite"], B: ["opposite"] },
  };
  let turnFailed = false; // a sequential turn returned an error: the round is incomplete
  let parseMsTotal = 0; // time spent parsing + validating the structured replies
  let groupingInvalid = 0;
  const heuristicRows: { turn: number; side: Side; evidenceHit: number; answered: number; sim: number; flags: boolean }[] = [];
  let groupingNotClean = 0; // analyses with any rejected / quarantined / missing / invented id
  let quarantinedTotal = 0;
  let missingTotal = 0;
  let splitTurns = 0; // turns where a known idea was spread over several agent groups (under-merging or a legitimate split)
  let impureTurns = 0; // turns where a group contained foreign players (over-merging)
  const auditNotes: string[] = [];
  // Persistent themes: the coordinator ingests submissions, schedules background semantic grouping automatically
  // (only when themes are unresolved and a reconciler is available) and never blocks a turn longer than waitMs.
  const coord = P ? createThemeCoordinator(engine, { roundId, scenario }) : undefined;
  const mergeEvents: string[] = [];
  let runsLogged = 0;
  const logNewRuns = () => {
    if (!coord) return;
    for (const { side, report: rep } of coord.runs().slice(runsLogged)) {
      runsLogged++;
      log(`  [grouping ${side}] ${rep.status}${rep.reason ? ` (${rep.reason})` : ""} | ${rep.requests} request(s), ${rep.failedRequests} failed | ${rep.durationMs} ms | merges ${rep.merges.length} | still awaiting reconciliation: ${rep.pendingThemeIds.length}${rep.errors.length ? ` | errors: ${rep.errors.map((e) => `[${e.kind}] ${e.message}`).join("; ")}` : ""}`);
      for (const m of rep.merges) {
        const ev = `Agent ${side}: ${m.from.join(", ")} merged into ${m.into}`;
        mergeEvents.push(ev);
        log(`    merge event: ${ev}`);
      }
      for (const e of rep.errors) failures.push(`semantic grouping ${side}: [${e.kind}] ${e.message}`);
    }
  };
  const logThemes = (side: Side, header: string) => {
    log(`  ${header}`);
    const themes = coord!.state(side).themes;
    for (const t of [...themes].sort((a, b) => b.players.length - a.players.length || a.seq - b.seq).slice(0, 12))
      log(`    ${t.id} | supporters ${t.players.length} | messages ${t.messages} | ${t.reviewed ? "grouped" : "AWAITING reconciliation"}${t.mergedFrom.length ? ` | merged from ${t.mergedFrom.join(",")}` : ""} | "${t.suggestion.slice(0, 60)}"`);
    if (themes.length > 12) log(`    ... +${themes.length - 12} more themes (all kept in the state)`);
  };
  if (coord) log(`  Semantic grouping: ${coord.semanticStatus().text}`);
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
    // Persistent mode: `arrives` is the engine's own turn number (transcript length + 1, so the first sequential turn is
    // Turn 3 after the two openings). Everything that has arrived by the start of this turn is submitted BEFORE the request.
    const turnNo = transcript.length + 1;
    const res = coord
      ? await (async () => {
          const r = await coord.nextTurn({ speaker, transcript: [...transcript], injections: submissions.filter((x) => x.arrives <= turnNo), maxWords: options.maxWords, timeoutMs: Math.min(options.turnTimeoutMs, remaining), waitMs: P!.waitMs });
          return r.result;
        })()
      : await engine.generateNextTurn({
          roundId,
          speaker,
          scenario,
          transcript: [...transcript],
          injections: submissions.filter((s) => s.arrives <= idx), // immutable snapshot of what has arrived so far
          consumedInjectionIds: consumed,
          maxWords: options.maxWords,
          timeoutMs: Math.min(options.turnTimeoutMs, remaining),
        });
    if (coord) logNewRuns();
    if (!res.ok) {
      failures.push(`turn ${res.turn} (Agent ${speaker}): [${res.error.kind}] ${res.error.message}`);
      stop = `failure on turn ${res.turn} (${res.error.kind}); not retried`;
      turnFailed = true;
      log(`\n  Turn ${res.turn}, Agent ${speaker}: ERROR [${res.error.kind}] ${res.error.message}`);
      if (res.error.inputTokens !== undefined || res.error.outputTokens !== undefined)
        log(`  failed request still used ${res.error.inputTokens ?? "?"} input / ${res.error.outputTokens ?? "?"} output tokens (counted in the partial cost); output cap ${(res.speaker === "A" ? config.agentA : config.agentB).maxOutputTokens}${res.error.kind === "truncated" ? "; thinking tokens count toward that cap" : ""}`);
      break;
    }
    const a = res.argument;
    const au = res.audience;
    au.processedIds.forEach((id) => consumed.add(id));
    au.includedIds.forEach((id) => includedEver.add(id));
    totals.duplicates += au.duplicateIds.length;
    totals.invalid += au.invalidIds.length;
    totals.chars += au.stats.chars;
    totals.processingMs += au.stats.processingMs;
    latencies.push(a.meta.latencyMs);
    turnsDone++;
    const words = wordCount(a.text);
    log(`\n  Turn ${a.turn}, Agent ${a.side} at ${((Date.now() - debateStart) / 1000).toFixed(1)}s — ${words} words${words > options.maxWords ? ` (OVER LIMIT ${options.maxWords})` : ""}${a.wordLimit ? ` | ${describeLimit(a.wordLimit)}` : ""}${a.meta.truncated ? " | REPLY CUT AT THE OUTPUT CAP: public argument salvaged, grouping metadata lost" : ""}`);
    if (a.wordLimit) limitStats.push({ label: `Turn ${a.turn} (Agent ${a.side})`, ...a.wordLimit });
    if (a.wordLimit?.shortened && a.wordLimit.originalText) log(`  original (unbounded) model argument, for diagnosis: ${a.wordLimit.originalText}`);
    turnLatencyByModel.push({ turn: a.turn ?? 0, side: a.side, model: a.meta.model, ms: a.meta.latencyMs });
    const s = au.stats;
    if (coord && res.briefing) {
      const au2 = coord.audit(speaker);
      const st = coord.state(speaker);
      const briefed = st.themes.filter((t) => res.briefing!.themes.some((b) => b.id === t.id));
      const players = new Set(briefed.flatMap((t) => t.players)).size;
      const submittedBoth = coord.audit("A").received + coord.audit("B").received;
      log(`  players who have submitted so far: ${submittedBoth} (Agent A ${coord.audit("A").received}, Agent B ${coord.audit("B").received}) | unique wordings for Agent ${speaker}: ${au2.themes}`);
      log(`  audience (persistent, Agent ${speaker}): received ${au2.received} | ingested ${au2.ingested} (+${s.absorbed ?? 0} since last turn) | blank ${au2.invalid} | extra submissions from an already-counted player ${au2.ignored} | MISSING from state ${au2.missing}${au2.missing ? " <-- PROBLEM" : ""}`);
      log(`  briefing: ${briefed.length} of ${au2.themes} wordings sent, representing ${au.includedIds.length} submissions from ${players} distinct players | omitted by the prompt budget: ${au.queuedIds.length} submissions (kept in state, NOT seen by the agent) | ${coord.semanticStatus().text}`);
      const shown = new Set(au.includedIds);
      const kindsHere = auditSpec.scored[speaker].filter((k) => submissions.some((x) => x.side === speaker && x.kind === k));
      const seen = (k: string) => new Set(submissions.filter((x) => x.side === speaker && x.kind === k && shown.has(x.id)).map((x) => x.playerId)).size;
      const want = (k: string) => new Set(submissions.filter((x) => x.side === speaker && x.kind === k && x.arrives <= res.turn).map((x) => x.playerId)).size;
      if (kindsHere.length) log(`  distinct supporters visible in the prompt (before the agent groups wordings): ${kindsHere.map((k) => `${k} ${seen(k)} (expected ${want(k)} ${seen(k) === want(k) ? "OK" : "MISMATCH"})`).join(" | ")}`);
      log(`  briefing sent to Agent ${speaker} (cumulative; first 12 of ${res.briefing.themes.length}):`);
      for (const t of res.briefing.themes.slice(0, 12)) log(`    ${t.id} | supporters ${t.supporters} | new ${t.newSupporters}${t.briefedBefore ? " | briefed before" : ""}${t.grouping ? " | awaiting reconciliation" : ""} | "${t.suggestion.slice(0, 70)}"`);
    } else {
      log(`  audience: snapshot ${s.received} | eligible for speaker ${s.forSpeaker} | included ${s.included} | queued ${s.queued} | duplicates ${s.duplicates} | invalid ${s.invalid} | text ${s.chars} chars | processing ${s.processingMs} ms${s.oldestQueuedAgeMs !== undefined ? ` | oldest queued ${Math.round(s.oldestQueuedAgeMs / 1000)}s` : ""}`);
      if (au.themes.length) log(`  themes sent (distinct players / messages): ${au.themes.slice(0, 8).map((t) => `${t.supporters}/${t.messages} "${t.text.slice(0, 50)}"`).join(" | ")}${au.themes.length > 8 ? ` | +${au.themes.length - 8} more` : ""}`);
      log(`  included IDs: ${au.includedIds.join(", ") || "none"}`);
    }
    if (coord) {
      // Cheap heuristics only (no extra model call): they do not judge quality.
      const bag = (t: string) => new Set(t.toLowerCase().match(/[a-z']+/g) ?? []);
      const mine = bag(a.text);
      const sim = Math.max(0, ...transcript.filter((e) => e.side === speaker && e.stage === "turn").map((e) => {
        const o = bag(e.text);
        const common = [...mine].filter((w) => o.has(w)).length;
        return common / (mine.size + o.size - common);
      }));
      const opp = [...transcript].reverse().find((e) => e.side !== speaker);
      const oppWords = bag(opp?.text ?? "");
      const answered = opp ? [...oppWords].filter((w) => w.length > 4 && mine.has(w)).length : 0;
      const evidenceHit = scenario.evidence.filter((e) => { const ws = (e.toLowerCase().match(/[a-z]{5,}/g) ?? []); return ws.length > 0 && ws.filter((w) => mine.has(w)).length >= Math.min(2, ws.length); }).length;
      const flags = /police confirmed|director admitted|guard confessed|cctv shows|claim (was )?already filed|concede|system prompt|ignore (all )?(previous|your)|full marks/i.test(a.text);
      log(`  quality heuristics (cheap checks, NOT a judgement; read the argument): scenario evidence items touched ${evidenceHit}/${scenario.evidence.length} | opponent's longer words reused (rebuttal-directness proxy) ${answered} | word overlap with own earlier turns ${sim.toFixed(2)}${sim > 0.5 ? " (REPEATING?)" : ""} | fabricated/adversarial phrases ${flags ? "PRESENT (check)" : "none"}`);
      heuristicRows.push({ turn: a.turn ?? 0, side: speaker, evidenceHit, answered, sim, flags });
    }
    if (coord && res.briefing) {
      const an = res.audienceAnalysis;
      if (!an) log(`  semantic grouping: no analysis returned`);
      else {
        parseMsTotal += an.parseMs;
        log(`  semantic grouping by Agent ${speaker} (same request as the argument; the agent's own interpretation, validated here; "used" is the agent's self-report; counts are computed from player ids) | ${an.valid ? "valid" : "INVALID"} | parse+validate ${an.parseMs} ms`);
        for (const [i, g] of an.groups.entries())
          log(`    G${i + 1} "${g.label}" | wordings ${g.sourceWordingIds.join(",")} | supporters ${g.supporters} (${(g.share * 100).toFixed(0)}% of ${an.totals.briefedPlayers} briefed players) | relevance ${g.relevance} | used (self-report): ${g.usedInArgument ? "yes" : "no"} | ${g.status}${g.claimedSupporters !== undefined ? ` | model claimed ${g.claimedSupporters} (ignored)` : ""}`);
        const ac = an.accounting;
        log(`    ACCOUNTING of ${ac.briefedWordings} briefed wordings / ${ac.briefedPlayers} distinct players (each wording has exactly one outcome${ac.balanced ? "" : "; NOT BALANCED"}): validated support ${ac.validated.wordings} wordings / ${ac.validated.players} players | unsafe (irrelevant, fabricated, adversarial) ${ac.unsafe.wordings}/${ac.unsafe.players} | unassigned (unclear) ${ac.unassigned.wordings}/${ac.unassigned.players} | QUARANTINED ${ac.quarantined.wordings}/${ac.quarantined.players} | MISSING ${ac.missing.wordings}/${ac.missing.players} | invented ids ${ac.unknownIds}`);
        log(`    set aside by the agent: ${an.unassigned.length ? an.unassigned.map((u) => `${u.wordingId} (${u.reason}, ${u.supporters})`).join(", ") : "none"} | excluded groups (relevance none): ${an.excludedGroups.length ? an.excludedGroups.map((x) => `"${x.label}" ${x.supporters}`).join(", ") : "none"}`);
        log(`    quarantined (conflicting or ambiguous, counted nowhere; messages stay in state): ${an.quarantined.length ? an.quarantined.map((q) => `${q.wordingId} ${q.issue}`).join(" | ") : "none"} | not mentioned by the agent: ${an.unmentionedWordingIds.length ? an.unmentionedWordingIds.join(",") : "none"}`);
        log(`    rejected / invalid model assignments: ${an.rejected.length ? "\n      " + an.rejected.map((r) => `[${r.kind}] ${r.detail}`).join("\n      ") : "none"}`);
        if (!an.valid) groupingInvalid++;
        if (!an.clean) groupingNotClean++;
        quarantinedTotal += an.accounting.quarantined.wordings;
        missingTotal += an.accounting.missing.wordings;
        const known = auditSpec.scored[speaker].filter((k) => submissions.some((x) => x.side === speaker && x.kind === k));
        if (known.length) {
          const wordingPlayers = new Map(coord.state(speaker).themes.map((t) => [t.id, t.players] as const));
          const audit = auditGrouping({
            analysis: an,
            playersOfWording: wordingPlayers,
            kindOfPlayer: new Map(submissions.filter((x) => x.playerId).map((x) => [x.playerId!, x.kind] as const)),
            scored: known,
            mustStaySeparate: auditSpec.separate[speaker],
            contradictory: auditSpec.contradictory[speaker],
            visiblePlayers: new Set(res.briefing.themes.flatMap((t) => wordingPlayers.get(t.id) ?? [])),
          });
          audit.lines.forEach((l) => log(l));
          for (const c of audit.categories) if (c.verdict === "IMPURE" || c.verdict === "SPLIT") auditNotes.push(`Turn ${a.turn} ${c.kind}: ${c.verdict}`);
          if (audit.contradictionsMerged.length) auditNotes.push(`Turn ${a.turn}: contradictory claims merged`);
          if (audit.noiseMerged.length) auditNotes.push(`Turn ${a.turn}: noise merged into a real idea`);
          if (audit.noiseAccepted.length) auditNotes.push(`Turn ${a.turn}: noise/contradiction accepted as relevant or used`);
          if (audit.categories.some((c) => c.verdict === "SPLIT")) splitTurns++;
          if (audit.categories.some((c) => c.verdict === "IMPURE")) impureTurns++;
        }
      }
    }
    log(`  ${a.text}\n  (${describeMeta(a.meta)})`);
    transcript.push({ stage: a.stage, side: a.side, text: a.text, turn: a.turn });
  }
  timings.turnsMs = Date.now() - turnsStart;
  timings.debateMs = Date.now() - debateStart;
  log(`\n  Debate stopped: ${stop}`);
  if (coord) {
    await coord.idle(20_000); // finish any grouping still running so the final report is complete (outside the debate budget)
    logNewRuns();
  }

  // ---- Phase 6: independent judge (everything above has been awaited: nothing is in flight)
  const shouldJudge = !turnFailed || options.judgePartial === true;
  log(`\n${line()}\nPHASE 6: INDEPENDENT JUDGE (${transcript.length} public arguments)`);
  if (!shouldJudge) log(`  NOT CALLED: a debate turn failed, so this round is INCOMPLETE and is not judged (pass --judge-partial to judge the partial transcript for debugging).`);
  else if (turnFailed) log(`  --judge-partial: judging a PARTIAL transcript of an incomplete debate. The verdict is not a result for a full round.`);
  const j0 = Date.now();
  const verdict = shouldJudge ? await engine.judgeDebate({ roundId, scenario, transcript }) : undefined;
  timings.judgeMs = Date.now() - j0;
  if (!verdict) {
    /* not judged */
  } else if (verdict.ok) {
    const v = verdict.verdict;
    log(`  Winner: Agent ${v.winner}\n  ${v.explanation}\n  Scores: ${JSON.stringify(v.scores)}\n  (${describeMeta(verdict.meta)})`);
    log(`  Judge latency: ${(timings.judgeMs / 1000).toFixed(1)}s (target ${options.judgeTargetMs / 1000}s${timings.judgeMs > options.judgeTargetMs ? " — OVER TARGET" : ""})`);
    const dim = (s: Side) => `evidence ${v.scores[s].evidence} | logic ${v.scores[s].logic} | rebuttal ${v.scores[s].rebuttal} | persuasion ${v.scores[s].persuasion} | overall ${v.overall?.[s] ?? "n/a"}`;
    log(`  Scores (0-10; overall = mean computed here):\n    Agent A: ${dim("A")}\n    Agent B: ${dim("B")}`);
    if (v.summary) log(`  Short summary: ${v.summary}`);
    for (const s of SIDES) log(`  Agent ${s} strengths: ${v.strengths?.[s].join(" | ") ?? "n/a"}\n  Agent ${s} weaknesses: ${v.weaknesses?.[s].join(" | ") ?? "n/a"}`);
    log(`  Validated references: ${v.references?.length ? v.references.map((r) => `${r.ref} (Agent ${r.side}) ${r.note}${r.quote ? ` "${r.quote}"` : ""}`).join("\n    ") : "none"}`);
    log(`  Rejected references: ${v.validation?.rejectedReferences.length ? v.validation.rejectedReferences.map((r) => `${r.ref}: ${r.reason}`).join("; ") : "none"}`);
    log(`  Unsupported assumptions: ${v.unsupportedAssumptions?.length ? v.unsupportedAssumptions.map((a) => `Agent ${a.side}${a.ref ? ` (${a.ref})` : ""}: ${a.assumption}`).join(" | ") : "none reported"}`);
    log(`  Closest / most decisive exchange: ${v.decisiveExchange ? `${v.decisiveExchange.refs.join(", ") || "no valid ref"} — ${v.decisiveExchange.description}` : "n/a"}`);
  } else {
    failures.push(`judge: [${verdict.error.kind}] ${verdict.error.message}`);
    log(`  ERROR [${verdict.error.kind}] ${verdict.error.message}`);
  }
  if (coord) {
    log(`\n${line()}\nPERSISTENT AUDIENCE THEMES (state after ${turnsDone} turns)`);
    const kindOf = new Map(submissions.map((x) => [x.id, x.kind]));
    for (const side of SIDES) {
      const au2 = coord.audit(side);
      logThemes(side, `Agent ${side}: ${au2.themes} themes`);
      log(`    submissions: received ${au2.received} | ingested ${au2.ingested} (blank ${au2.invalid}, extra from an already-counted player ${au2.ignored}) | missing from state ${au2.missing} ${au2.missing ? "<-- PROBLEM " + au2.missingIds.join(",") : "(none lost)"}`);
      const st = coord.state(side);
      log(`    messages ${st.themes.reduce((n, t) => n + t.messages, 0)} | distinct players across themes ${new Set(st.themes.flatMap((t) => t.players)).size}`);
      for (const t of [...st.themes].sort((a, b) => b.players.length - a.players.length).slice(0, 6)) {
        const kinds = new Map<string, number>();
        t.sourceIds.forEach((id) => kinds.set(kindOf.get(id) ?? "?", (kinds.get(kindOf.get(id) ?? "?") ?? 0) + 1));
        log(`      ${t.id}: ${[...kinds].map(([k, n]) => `${k}x${n}`).join(" ")}`);
      }
    }
    const g = coord.grouping();
    log(`  semantic grouping: ${coord.semanticStatus().text}`);
    const lastTurnNo = transcript.reduce((n, e) => Math.max(n, e.turn ?? 0), 0);
    log(`  AUDIENCE TOTALS: ${submissions.length} submissions in the schedule | distinct players ${new Set(submissions.map((x) => x.playerId)).size} | Agent A ${submissions.filter((x) => x.side === "A").length}, Agent B ${submissions.filter((x) => x.side === "B").length}`);
    log(`    arrived after the last debate turn (Turn ${lastTurnNo}), never submitted: ${submissions.filter((x) => x.arrives > lastTurnNo).length}`);
    for (const side of SIDES) {
      const late = coord.neverBriefed(side);
      log(`    Agent ${side}: in state but never in any briefing (arrived after the side's last request, or always omitted by the budget; could not influence any argument): ${late.length}${late.length ? ` [${late.slice(0, 8).join(", ")}${late.length > 8 ? ", ..." : ""}]` : ""}`);
    }
    const represented = SIDES.reduce((n, s) => n + coord.state(s).themes.filter((t) => t.briefedTurns.length).reduce((m, t) => m + t.sourceIds.length, 0), 0);
    const ingested = SIDES.reduce((n, s) => n + coord.audit(s).ingested, 0);
    log(`  AUDIENCE: ingested into the persistent state ${ingested} of ${submissions.length} schedule entries | REPRESENTED in a SUCCESSFUL debating turn ${represented} (${((represented / Math.max(1, submissions.length)) * 100).toFixed(1)}%): only these could have influenced an argument${turnFailed ? " | the debate FAILED, so submissions that reached only a failed request are not counted as represented" : ""}`);
    log(`  AUDIENCE REPRESENTED: ${represented} of ${submissions.length} submissions (${((represented / Math.max(1, submissions.length)) * 100).toFixed(1)}%) appeared in at least one briefing of a successful turn to their own agent; the rest could not influence any argument (see the lines above)`);
    const shortened = limitStats.filter((l) => l.shortened);
    log(`  WORD LIMIT: ${shortened.length} of ${limitStats.length} public arguments needed shortening${shortened.length ? ` [${shortened.map((l) => `${l.label}: ${l.originalWords}->${l.finalWords} ${l.method}${l.lossy ? " LOSSY" : ""}`).join("; ")}]` : ""} | final word counts: ${limitStats.map((l) => `${l.label.replace("Agent ", "").replace("Opening ", "Op")}=${l.finalWords}`).join(", ")} | max ${Math.max(0, ...limitStats.map((l) => l.finalWords))}`);
    log(`  GROUPING ACCURACY SUMMARY: turns with a known idea split over several agent groups ${splitTurns} | turns with foreign players inside a group (over-merging) ${impureTurns} | invalid/missing analyses ${groupingInvalid} | analyses with validation issues (rejected / quarantined / missing / invented ids) ${groupingNotClean} | wordings quarantined in total ${quarantinedTotal} | wordings the agent never accounted for ${missingTotal}`);
    log(`  PER-TURN LATENCY BY MODEL: ${turnLatencyByModel.map((t) => `T${t.turn} ${t.side} ${t.model} ${t.ms}ms`).join(" | ")}`);
    log(`  HEURISTICS BY TURN (cheap checks): ${heuristicRows.map((h) => `T${h.turn}${h.side}: evidence ${h.evidenceHit}, rebuts ${h.answered}, repeat ${h.sim.toFixed(2)}${h.flags ? ", FLAGGED" : ""}`).join(" | ")}`);
    log(`  GROUPING QUALITY (model self-reported grouping, audited against known player categories): invalid/missing analyses ${groupingInvalid} | audit notes: ${auditNotes.length ? auditNotes.join("; ") : "none (every checked category PASSED)"}`);
    log(`  TIMING: openings ${timings.openingsMs} ms | per-turn latency ms [${latencies.join(", ")}] | structured-output parse+validate ${Math.round(parseMsTotal * 100) / 100} ms total | judge ${timings.judgeMs} ms`);
    if (verdict?.ok) {
      const j = verdict.meta;
      log(`  TOKENS: judge in/out ${j.inputTokens ?? "n/a"}/${j.outputTokens ?? "n/a"} | debaters (openings + turns) in/out ${tracker.t.inputTokens - (j.inputTokens ?? 0)}/${tracker.t.outputTokens - (j.outputTokens ?? 0)}`);
    }
    log(g.runs ? `  optional reconciler (separate requests): ${g.runs} runs | ${g.requests} requests (${g.failedRequests} failed) | grouping time ${g.totalMs} ms | time turns spent waiting for it ${g.waitedMs} ms (inside the ${options.budgetMs / 1000}s budget)` : `  separate semantic-grouping requests: 0 (the debating agent groups related wordings inside each turn request)`);
    log(`  merge events (${mergeEvents.length}):${mergeEvents.length ? "\n    " + mergeEvents.join("\n    ") : " none"}`);
    // Privacy checks on the prompts actually sent
    const textsOf = (side: Side) => [...new Set(submissions.filter((x) => x.side === side).map((x) => x.text.toLowerCase().trim()))];
    const leaks = (calls: { prompt: string }[], texts: string[]) => calls.filter((c) => texts.some((t) => c.prompt.toLowerCase().includes(t))).length;
    const agent = (side: Side) => captured.filter((c) => c.system.includes(`You are Agent ${side},`));
    const recon = (side: Side) => captured.filter((c) => c.prompt.includes(`These suggestions are for Agent ${side}`));
    const judge = captured.filter((c) => c.system === JUDGE_SYSTEM);
    const mark = (n: number) => (n === 0 ? "OK" : `LEAK in ${n} prompt(s)`);
    log(`  privacy: Agent B prompts containing A's private suggestions: ${mark(leaks(agent("B"), textsOf("A")))} (${agent("B").length} prompts checked)`);
    log(`  privacy: Agent A prompts containing B's private suggestions: ${mark(leaks(agent("A"), textsOf("B")))} (${agent("A").length} prompts checked)`);
    log(`  privacy: reconciliation prompts for A containing B's text: ${mark(leaks(recon("A"), textsOf("B")))} | for B containing A's text: ${mark(leaks(recon("B"), textsOf("A")))}`);
    log(`  privacy: judge prompts containing any audience text, counts or briefing: ${mark(leaks(judge, [...textsOf("A"), ...textsOf("B")]) + judge.filter((c) => /supporters|AUDIENCE|briefing|theme/i.test(c.prompt)).length)} (${judge.length} prompts checked)`);
    log(`  "Reflected in the arguments": NOT assessed automatically. Read Agent A's turns against the briefings above.`);
    return finish(turnFailed ? "incomplete" : verdict?.ok ? "debated" : "failed", verdict);
  }
  // Audience accounting. "Reflected in the arguments" cannot be established automatically (no extra LLM call): review the turns.
  const spoke = (side: Side, upTo: number, arrives: number) => {
    for (let idx = Math.max(1, arrives); idx <= upTo; idx++) if ((idx % 2 === 1 ? "A" : "B") === side) return true;
    return false;
  };
  const unprocessed = submissions.filter((s) => !consumed.has(s.id));
  const queued = unprocessed.filter((s) => spoke(s.side, turnsDone, s.arrives));
  const unreached = unprocessed.length - queued.length;
  log(`\n  AUDIENCE TOTALS (${submissions.length} submissions generated)`);
  log(`    included in a prompt (unique): ${includedEver.size} | covered as exact duplicates: ${totals.duplicates} | invalid: ${totals.invalid}`);
  log(`    still queued after the last turn: ${queued.length} | never reached an agent turn (arrived too late for that side): ${unreached}`);
  log(`    reflected in the arguments: NOT assessed automatically (included is not the same as followed; read the turns)`);
  log(`    audience text sent: ${totals.chars} chars over ${turnsDone} turns | total processing time ${Math.round(totals.processingMs * 100) / 100} ms`);
  if (unprocessed.length) log(`    NOT every submission could be processed within ${turnsDone} turns: ${unprocessed.length} remain unprocessed.`);
  return finish(turnFailed ? "incomplete" : verdict?.ok ? "debated" : "failed", verdict);
}
