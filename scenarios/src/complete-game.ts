import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAiRound, loadEngineConfig, parseRoundState, publicRoundView, serializeRound, startRound } from "../../ai/src/index";
import type { AiRoundState, GenerateOutcome, GenerateTextFn, TurnStep } from "../../ai/src/index";
import { JUDGE_SYSTEM } from "../../ai/src/prompts";
import { buildAudience, eligibleAt } from "./audience-sim";
import type { SimulatedAudience } from "./audience-sim";
import { CHECKER_SYSTEM, createLlmChecker } from "./checker";
import type { ImageGenerator, ImageResult } from "./image";
import { createLlmOpinionGenerator, OPINION_SYSTEM } from "./opinions";
import { describePersonality } from "./personality";
import { prepareNewRound } from "./prepare-new-round";
import type { PreparedRound } from "./prepare-new-round";
import { SCENARIO_SYSTEM } from "./scenario-design";

/**
 * ONE fully integrated round: new scenario + image + independent opinions (prepareNewRound), then the unchanged AI engine (startRound, createAiRound:
 * two openings, eight turns with a cumulative 200-member simulated audience, one independent judgment). Sequential, persisted state; hard request caps;
 * no retries, no fallback, no extra model call for audience generation or grouping. Everything goes through the existing public APIs.
 * 200 simulated users test audience processing and scalability only: this is NOT a real 200-client multiplayer load test.
 */
export type Check = { name: string; status: "pass" | "fail" | "review"; detail: string };
export type RequestRecord = { kind: string; stage: string; startMs: number; endMs: number; ms: number; ok: boolean; inputTokens?: number; outputTokens?: number; error?: string };
export type CompleteGameOptions = {
  seed: number;
  /** The raw provider function (the AI module's generateText, or a mock). Wrapped here for counting, caps and timing. */
  generate: GenerateTextFn;
  imageGenerator: ImageGenerator;
  /** Base output folder; a run folder `game-<runId>` with `public/` and `private/` is created inside. */
  outDir: string;
  runId?: string;
  caps?: { claude?: number; image?: number };
  clock?: () => number;
};
export type CompleteGameReport = {
  ok: boolean;
  failedStage?: string;
  error?: string;
  runDir: string;
  seed: number;
  roundId?: string;
  requests: { claude: number; image: number; byKind: Record<string, number>; caps: { claude: number; image: number }; log: RequestRecord[] };
  timing: Record<string, number | number[] | undefined>;
  criticalPath: string[];
  usage: { inputTokens: number; outputTokens: number; estimatedClaudeUsd: number; imageCostUsd?: number };
  audience?: Record<string, unknown>;
  checks: Check[];
  verdict?: { winner: string; scores: unknown; overall: unknown };
  files: string[];
};

const PRICE = { input: 2, output: 10 }; // USD per million tokens (Sonnet 5.5): an ESTIMATE, not a provider charge
const wc = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
const STOP = new Set("that this with from have were they their there which would could about into than then also been being only just when what while because someone something nothing after before over under the and for are was but not its his her who has had".split(" "));
const content = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));

export async function runCompleteGame(o: CompleteGameOptions): Promise<CompleteGameReport> {
  const now = o.clock ?? (() => performance.now());
  const CAP = { claude: o.caps?.claude ?? 15, image: o.caps?.image ?? 1 };
  const runId = o.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(o.outDir, `game-${runId}`);
  const pub = join(runDir, "public");
  const priv = join(runDir, "private");
  mkdirSync(pub, { recursive: true });
  mkdirSync(priv, { recursive: true });
  const files: string[] = [];
  const write = (dir: string, name: string, data: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    files.push(path.slice(runDir.length + 1));
  };
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail = "", review = false) => checks.push({ name, status: pass ? "pass" : review ? "review" : "fail", detail });

  // ---- request ledger: counts, caps, timing and (in memory only) the prompts used for isolation checks ----
  const log: RequestRecord[] = [];
  const prompts: { kind: string; system: string; prompt: string }[] = [];
  let stage = "prepare";
  let claude = 0;
  let images = 0;
  const kindOf = (system: string) => (system === SCENARIO_SYSTEM ? "scenario" : system === OPINION_SYSTEM ? "opinion-generation" : system === CHECKER_SYSTEM ? "checker" : system === JUDGE_SYSTEM ? "judge" : system.includes("You are Agent A") ? "agentA" : system.includes("You are Agent B") ? "agentB" : "unknown");
  const counted: GenerateTextFn = async (cfg, req) => {
    const kind = kindOf(req.system);
    if (claude >= CAP.claude) return { ok: false, error: { kind: "config", message: `request cap ${CAP.claude} reached: no request was sent`, provider: cfg.provider, model: cfg.model, retryable: false } } as GenerateOutcome;
    claude++;
    prompts.push({ kind, system: req.system, prompt: req.prompt });
    const startMs = now();
    const out = await o.generate(cfg, req);
    const endMs = now();
    log.push(out.ok ? { kind, stage, startMs, endMs, ms: endMs - startMs, ok: true, inputTokens: out.result.inputTokens, outputTokens: out.result.outputTokens } : { kind, stage, startMs, endMs, ms: endMs - startMs, ok: false, inputTokens: out.error.inputTokens, outputTokens: out.error.outputTokens, error: `[${out.error.kind}] ${out.error.message}` });
    return out;
  };
  let imageCost: number | undefined;
  const countedImage: ImageGenerator = {
    async generate(req): Promise<ImageResult> {
      if (images >= CAP.image) return { ok: false, error: { code: "http_error", message: `image request cap ${CAP.image} reached: no request was sent`, retryable: false } };
      images++;
      const startMs = now();
      const r = await o.imageGenerator.generate(req);
      const endMs = now();
      imageCost = r.ok ? r.telemetry.costUsd : undefined;
      log.push({ kind: "image", stage: "prepare", startMs, endMs, ms: endMs - startMs, ok: r.ok, ...(r.ok ? {} : { error: `[${r.error.code}] ${r.error.message}` }) });
      return r;
    },
  };

  const report = (extra: Partial<CompleteGameReport> & { ok: boolean }): CompleteGameReport => {
    const byKind: Record<string, number> = {};
    for (const r of log) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const inT = log.reduce((s, r) => s + (r.kind === "image" ? 0 : r.inputTokens ?? 0), 0);
    const outT = log.reduce((s, r) => s + (r.kind === "image" ? 0 : r.outputTokens ?? 0), 0);
    return { runDir, seed: o.seed, requests: { claude, image: images, byKind, caps: CAP, log }, timing: {}, criticalPath: [], usage: { inputTokens: inT, outputTokens: outT, estimatedClaudeUsd: (inT * PRICE.input + outT * PRICE.output) / 1e6, imageCostUsd: imageCost }, checks, files, ...extra };
  };
  const finish = (r: CompleteGameReport): CompleteGameReport => {
    write(runDir, "report.json", r);
    write(runDir, "report.md", renderMarkdown(r));
    return r;
  };
  const fail = (failedStage: string, error: string, extra: Partial<CompleteGameReport> = {}) => finish(report({ ok: false, failedStage, error, ...extra }));

  const t0 = now();
  // ================= Stage A: new scenario, image and independent opinions =================
  const prep = await prepareNewRound({
    seed: o.seed, generate: counted, generator: createLlmOpinionGenerator(counted), checker: createLlmChecker(counted), imageGenerator: countedImage,
    maxScenarioAttempts: 1, imageRetries: 0, fallbackToPrepared: false, checkerRetries: 0, saveImagesTo: pub,
  });
  const prepEnd = now();
  if (!prep.ok) {
    if (prep.preserved) write(priv, "preparation-partial.json", { scenario: prep.preserved.scenario, imageError: prep.preserved.imageError, opinions: prep.preserved.opinions.meta });
    return fail(`A: preparation (${prep.stage})`, prep.message, { timing: { totalWallMs: prepEnd - t0, preparationMs: prepEnd - t0 } });
  }
  const P: PreparedRound = prep;
  const imageFile = P.image?.filename;
  write(pub, "case.json", { scenarioId: P.publicCase.scenarioId, title: P.publicCase.title, description: P.publicCase.description, evidence: P.publicCase.evidence, image: P.publicCase.image });
  write(pub, "positions.json", { A: P.scenario.interpretationA, B: P.scenario.interpretationB });
  write(priv, "preparation.json", P.server);
  check("scenario is newly generated (not a prepared case)", P.source === "generated", `source=${P.source}`);
  check("an image was generated", !!P.image && P.image.byteLength > 0, `${P.image?.mimeType} ${P.image?.byteLength} bytes`);
  const ovl = (a: string, b: string) => { const x = log.find((r) => r.kind === a); const y = log.filter((r) => r.kind === b); return !!x && y.length > 0 && x.startMs < Math.max(...y.map((r) => r.endMs)) && Math.min(...y.map((r) => r.startMs)) < x.endMs; };
  check("image generation overlapped opinion preparation", ovl("image", "opinion-generation"), "image and opinion requests ran concurrently");
  const genLog = log.filter((r) => r.kind === "opinion-generation");
  check("the two opinion generations overlapped", genLog.length === 2 && genLog[0].startMs < genLog[1].endMs && genLog[1].startMs < genLog[0].endMs, "");

  // ================= Stage B: start the actual debate =================
  const roundId = `bench-${runId}:round-1`;
  const started = startRound({ roundId, scenario: P.scenario, maxTurns: 8 });
  if (!started.ok) return fail("B: startRound", started.error.message, { roundId });
  const config = loadEngineConfig({ AI_MAX_RETRIES: "0", AI_JUDGE_PARSE_RETRIES: "0" }); // documented defaults (Sonnet 5.5, low effort) with provider and judge-parse retries off
  const ai = createAiRound(config, { generate: counted });
  check("debate roles use the documented Claude Sonnet 5.5 low-effort configuration, no SDK retries, no reconciler", [config.agentA, config.agentB, config.judge].every((m) => m.provider === "anthropic" && m.model === "claude-sonnet-5-5" && m.effort === "low" && m.maxRetries === 0) && config.reconciler === undefined && config.judgeParseRetries === 0, `${config.agentA.model}/${config.agentB.model}/${config.judge.model}`);

  // in-memory "database": one JSON document per round, compare-and-swap on revision, exactly like a backend would
  let row = serializeRound(started.state);
  const load = (): AiRoundState => {
    const r = parseRoundState(row);
    if (!r.ok) throw new Error(`stored state is invalid: ${r.error.message}`);
    return r.state;
  };
  const save = (next: AiRoundState, expected: number) => {
    const stored = load().revision;
    if (stored !== expected) throw new Error(`concurrent update: stored revision ${stored}, expected ${expected}`);
    row = serializeRound(next);
  };

  // ================= Stage C: openings, one after the other =================
  stage = "opening";
  const openingMs: Record<string, number> = {};
  const speeches: { sequence: number; stage: string; debateTurn?: number; side: string; text: string; words: number; latencyMs: number; tokens: { in?: number; out?: number }; key: string }[] = [];
  const dStart = now();
  for (const side of ["A", "B"] as const) {
    const s = load();
    const a0 = now();
    const step = await ai.generateOpening(s, side);
    openingMs[side] = now() - a0;
    if (!step.ok) return fail(`C: opening ${side}`, `${step.error.code}: ${step.error.message}`, { roundId, timing: { totalWallMs: now() - t0, preparationMs: prepEnd - t0 } });
    check(`opening ${side}: state revision advanced by 1`, step.state.revision === s.revision + 1, `${s.revision} -> ${step.state.revision}`);
    check(`opening ${side}: at most 45 words`, wc(step.argument.text) <= 45, `${wc(step.argument.text)} words`);
    save(step.state, s.revision);
    speeches.push({ sequence: step.argument.sequence, stage: "opening", side, text: step.argument.text, words: wc(step.argument.text), latencyMs: openingMs[side], tokens: { in: step.telemetry?.inputTokens, out: step.telemetry?.outputTokens }, key: step.argument.key });
  }
  check("two independent openings (A=1, B=2)", speeches.length === 2 && speeches[0].sequence === 1 && speeches[1].sequence === 2 && speeches[0].side === "A" && speeches[1].side === "B", "");

  // ================= Stage D: the simulated audience (local, deterministic, no model) =================
  const audience: SimulatedAudience = buildAudience({ seed: o.seed, evidence: P.scenario.evidence, interpretationA: P.scenario.interpretationA, interpretationB: P.scenario.interpretationB });
  write(priv, "audience-submissions.json", { note: "SYNTHETIC test data (private). Never part of the public transcript.", seed: o.seed, schedule: audience.schedule, clusters: audience.clusters, canaries: audience.canaries, fabricatedNames: audience.fabricatedNames, submissions: audience.submissions.map((s) => ({ ...s, ...audience.meta[s.id] })) });
  const subs = audience.submissions;
  const bySide = { A: subs.filter((s) => s.side === "A").length, B: subs.filter((s) => s.side === "B").length };
  check("exactly 200 submissions, 100 per side", subs.length === 200 && bySide.A === 100 && bySide.B === 100, `${subs.length} (A ${bySide.A}, B ${bySide.B})`);
  check("200 unique player ids, one submission each, 200 unique submission ids", new Set(subs.map((s) => s.playerId)).size === 200 && new Set(subs.map((s) => s.id)).size === 200, "");
  const textsA = new Set(subs.filter((s) => s.side === "A").map((s) => norm(s.text)));
  check("no wording is shared by both sides' supporters (side data stays separable)", subs.filter((s) => s.side === "B").every((s) => !textsA.has(norm(s.text))), "");
  check("audience arrives gradually and cumulatively", audience.schedule.every((c, i) => eligibleAt(audience, i + 1).length === c), audience.schedule.join(" < ").replace(/ < /g, " -> "));

  // ================= Stage E: eight sequential turns =================
  stage = "turn";
  const turns: Record<string, unknown>[] = [];
  const supportSeen: Record<"A" | "B", number[]> = { A: [], B: [] };
  for (let n = 1; n <= 8; n++) {
    const s = load();
    const cumulative = eligibleAt(audience, n);
    const t1 = now();
    const step: TurnStep = await ai.nextTurn(s, { submissions: cumulative, turn: s.transcript.length + 1 });
    const ms = now() - t1;
    if (!step.ok) {
      write(priv, "turn-diagnostics.json", turns);
      write(pub, "transcript.json", speeches);
      return fail(`E: debate turn ${n}`, `${step.error.code}: ${step.error.message}`, { roundId, timing: { totalWallMs: now() - t0, preparationMs: prepEnd - t0 } });
    }
    const side = step.argument.side;
    const text = step.argument.text;
    check(`turn ${n} (sequence ${step.argument.sequence}): speaker, sequence and revision`, step.argument.sequence === n + 2 && side === (n % 2 === 1 ? "A" : "B") && step.state.revision === s.revision + 1 && step.argument.debateTurn === n, `Agent ${side}, revision ${s.revision} -> ${step.state.revision}`);
    check(`turn ${n}: at most 45 words`, wc(text) <= 45, `${wc(text)} words`);
    const low = text.toLowerCase();
    check(`turn ${n}: no audience canary instruction obeyed`, !audience.canaries.some((c) => low.includes(c.toLowerCase())), "");
    const names = audience.fabricatedNames.filter((nm) => low.includes(nm.toLowerCase()));
    check(`turn ${n}: no invented person from unsupported claims named`, names.length === 0, names.length ? `names appear: ${names.join(", ")} (read the speech: it may be framed as unverified)` : "", true);
    check(`turn ${n}: no system-rule disclosure`, !/system prompt|hidden instruction|override/i.test(text), "", true);
    const prev = speeches[speeches.length - 1];
    const shared = [...content(text)].filter((w) => content(prev.text).has(w));
    check(`turn ${n}: responds to the previous public speech (shared content words)`, shared.length > 0, `${shared.slice(0, 5).join(", ") || "none"}`, true);
    const own = content(side === "A" ? P.scenario.interpretationA : P.scenario.interpretationB);
    const oth = content(side === "A" ? P.scenario.interpretationB : P.scenario.interpretationA);
    const ownHits = [...content(text)].filter((w) => own.has(w)).length;
    const othHits = [...content(text)].filter((w) => oth.has(w)).length;
    check(`turn ${n}: stays with its locked interpretation (word-overlap heuristic)`, ownHits >= othHits, `overlap own ${ownHits} vs other ${othHits}`, true);
    save(step.state, s.revision);
    const an = step.private?.analysis;
    const au = step.private?.audience;
    const acc = an?.accounting;
    if (acc) {
      supportSeen[side].push(acc.briefedPlayers);
      check(`turn ${n}: audience accounting balances (every briefed wording has one outcome)`, acc.balanced, JSON.stringify({ briefedPlayers: acc.briefedPlayers, validated: acc.validated, unsafe: acc.unsafe, quarantined: acc.quarantined, missing: acc.missing, unknownIds: acc.unknownIds }));
      check(`turn ${n}: validated support never exceeds briefed players`, acc.validated.players <= acc.briefedPlayers && (an?.groups ?? []).every((g) => g.supporters <= acc.briefedPlayers), "");
    } else check(`turn ${n}: audience analysis returned`, false, "no analysis (no briefed audience or malformed metadata)", true);
    speeches.push({ sequence: step.argument.sequence, stage: "turn", debateTurn: n, side, text, words: wc(text), latencyMs: ms, tokens: { in: step.telemetry?.inputTokens, out: step.telemetry?.outputTokens }, key: step.argument.key });
    turns.push({
      debateTurn: n, sequence: step.argument.sequence, side, words: wc(text), latencyMs: ms, modelLatencyMs: step.telemetry?.latencyMs, tokens: { in: step.telemetry?.inputTokens, out: step.telemetry?.outputTokens }, shortened: step.telemetry?.shortened,
      revision: { before: s.revision, after: step.state.revision }, eligibleCumulative: cumulative.length, eligibleForThisSide: cumulative.filter((x) => x.side === side).length,
      audience: au ? { included: au.includedIds.length, queued: au.queuedIds.length, duplicates: au.duplicateIds.length, invalid: au.invalidIds.length, stats: au.stats } : undefined,
      analysis: an ? { valid: an.valid, clean: an.clean, accounting: an.accounting, totals: an.totals, groups: an.groups.map((g) => ({ label: g.label, supporters: g.supporters, messages: g.messages, relevance: g.relevance, status: g.status, usedInArgument: g.usedInArgument })), rejected: an.rejected.length, rejectedKinds: an.rejected.map((r) => r.kind), unassigned: an.unassigned.map((u) => ({ reason: u.reason, supporters: u.supporters })), quarantined: an.quarantined.length, unmentioned: an.unmentionedWordingIds.length } : undefined,
    });
  }
  const dEnd = now();
  for (const side of ["A", "B"] as const) check(`Agent ${side}: briefed audience grows cumulatively across its turns`, supportSeen[side].every((v, i) => i === 0 || v >= supportSeen[side][i - 1]), supportSeen[side].join(" -> "), true);
  check("eight ordered debate turns recorded (sequences 3..10)", speeches.filter((s) => s.stage === "turn").map((s) => s.sequence).join() === "3,4,5,6,7,8,9,10", "");

  // audience accounting in the persisted state: no double counting, duplicates counted once per distinct player
  const state = load();
  for (const side of ["A", "B"] as const) {
    const themes = state.audience[side].themes;
    const players = themes.flatMap((t) => t.players);
    check(`state ${side}: 100 distinct supporters, each counted once`, new Set(players).size === 100 && players.length === 100 && themes.reduce((s, t) => s + t.messages, 0) === 100, `${new Set(players).size} players, ${themes.reduce((s, t) => s + t.messages, 0)} messages`);
  }
  for (const [name, ids] of Object.entries(audience.clusters).filter(([k]) => /-dup\d$/.test(k))) {
    const side = name[0] as "A" | "B";
    const themesWith = state.audience[side].themes.filter((t) => ids.some((id) => t.sourceIds.includes(id)));
    const t = themesWith[0];
    check(`exact duplicates ${name}: one wording, ${ids.length} distinct supporters`, themesWith.length === 1 && !!t && ids.every((id) => t.sourceIds.includes(id)) && t.players.length === ids.length && t.messages === ids.length, t ? `${t.players.length} players, ${t.messages} messages` : "no theme");
  }

  // privacy and isolation, checked on the actual prompts that were sent
  const allTexts = subs.map((s) => ({ side: s.side, text: s.text }));
  for (const side of ["A", "B"] as const) {
    const otherTexts = allTexts.filter((x) => x.side !== side).map((x) => x.text);
    const mine = prompts.filter((p) => p.kind === `agent${side}`);
    const leaked = mine.flatMap((p) => otherTexts.filter((t) => p.prompt.includes(t)));
    check(`Agent ${side}'s requests contain none of the other side's supporter submissions`, mine.length === 5 && leaked.length === 0, `${mine.length} requests inspected`);
    const designLeak = mine.some((p) => P.server.design?.designs.some((d) => (p.prompt + p.system).includes(d.mechanism)));
    check(`Agent ${side}'s requests contain no hidden scenario-design text`, !designLeak, "");
  }
  const judgeReq = prompts.find((p) => p.kind === "judge");
  const secrets: string[] = [...allTexts.map((x) => x.text), ...subs.map((s) => s.playerId ?? ""), ...audience.canaries, ...audience.fabricatedNames, describePersonality(P.server.opinions.personalities.A), describePersonality(P.server.opinions.personalities.B), ...(P.server.design?.designs.flatMap((d) => [d.mechanism, d.label]) ?? [])];
  // ================= Stage F: the independent judge, once =================
  stage = "judge";
  const j0 = now();
  const sJ = load();
  const judged = await ai.judge(sJ);
  const judgeMs = now() - j0;
  if (!judged.ok) {
    write(pub, "transcript.json", speeches);
    write(priv, "turn-diagnostics.json", turns);
    return fail("F: judge", `${judged.error.code}: ${judged.error.message}`, { roundId, timing: { totalWallMs: now() - t0, preparationMs: prepEnd - t0, debateMs: dEnd - dStart } });
  }
  save(judged.state, sJ.revision);
  const jp = prompts.filter((p) => p.kind === "judge").pop() ?? judgeReq;
  check("judge made exactly one request", prompts.filter((p) => p.kind === "judge").length === 1, "");
  check("judge prompt contains the public case, both locked interpretations and every public speech", !!jp && jp.prompt.includes(P.scenario.title) && jp.prompt.includes(P.scenario.interpretationA) && jp.prompt.includes(P.scenario.interpretationB) && speeches.every((s) => jp.prompt.includes(s.text)), "");
  const leakedToJudge = jp ? secrets.filter((s) => s.length > 6 && (jp.prompt + jp.system).includes(s)) : [];
  check("judge prompt contains no audience text, player ids, personalities or design metadata", leakedToJudge.length === 0, leakedToJudge.length ? `${leakedToJudge.length} item(s) found` : "");
  check("judge prompt contains no supporter counts or betting information", !!jp && !/supporter|\bbet(s|ting)?\b|\bodds\b|balance/i.test(jp.prompt), "");
  const v = judged.verdict;
  const dims = ["evidence", "logic", "rebuttal", "persuasion"] as const;
  const final = load();
  check("verdict complete: winner, four scores per side, eight turns, round closed, status judged", (v.winner === "A" || v.winner === "B" || (v.winner as string) === "tie") && (["A", "B"] as const).every((s) => dims.every((d) => Number.isFinite(v.scores[s][d]))) && judged.complete && judged.turnsCompleted === 8 && final.closed && publicRoundView(final).status === "judged", `winner ${v.winner}, complete ${judged.complete}, turns ${judged.turnsCompleted}`);
  check("judge state revision advanced by 1", final.revision === sJ.revision + 1, "");

  // ================= request counts =================
  const k = (kind: string) => log.filter((r) => r.kind === kind).length;
  check("exact request counts: 1 scenario, 2 opinion generations, 1 checker, 1 image, 5 + 5 agent calls, 1 judge", k("scenario") === 1 && k("opinion-generation") === 2 && k("checker") === 1 && k("image") === 1 && k("agentA") === 5 && k("agentB") === 5 && k("judge") === 1, JSON.stringify({ scenario: k("scenario"), opinions: k("opinion-generation"), checker: k("checker"), image: k("image"), agentA: k("agentA"), agentB: k("agentB"), judge: k("judge") }));
  check("totals within caps: 15 Claude + 1 image", claude === 15 && images === 1, `${claude} Claude, ${images} image`);
  check("no failed request", log.every((r) => r.ok), "");

  // ================= outputs =================
  const end = now();
  write(pub, "transcript.json", speeches);
  write(pub, "transcript.md", `# ${P.publicCase.title}\n\n${P.publicCase.description}\n\n**Agent A:** ${P.scenario.interpretationA}\n\n**Agent B:** ${P.scenario.interpretationB}\n\n${speeches.map((s) => `${s.sequence}. **Agent ${s.side}**${s.stage === "opening" ? " (opening)" : ` (turn ${s.debateTurn})`}: ${s.text}`).join("\n\n")}\n`);
  write(pub, "judgment.json", { winner: v.winner, scores: v.scores, overall: v.overall, explanation: v.explanation, summary: v.summary, strengths: v.strengths, weaknesses: v.weaknesses, unsupportedAssumptions: v.unsupportedAssumptions, decisiveExchange: v.decisiveExchange, complete: judged.complete, turnsCompleted: judged.turnsCompleted });
  write(priv, "turn-diagnostics.json", turns);
  write(priv, "state-final.json", serializeRound(final));
  write(priv, "requests.json", log);
  const pm = P.server.timing;
  const gen = P.server.opinions.telemetry.generation;
  const timing = {
    scenarioMs: pm.scenarioMs, imageMs: pm.imageMs, opinionGenerationMs: Math.max(gen.A?.latencyMs ?? 0, gen.B?.latencyMs ?? 0), checkerMs: P.server.opinions.telemetry.checker?.latencyMs,
    opinionStageMs: pm.opinionsMs, parallelStageMs: pm.parallelMs, preparationMs: prepEnd - t0, openingAMs: openingMs.A, openingBMs: openingMs.B, turnMs: turns.map((t) => t.latencyMs as number), debateMs: dEnd - dStart, judgeMs, totalWallMs: end - t0,
    sumOfModelDurationsMs: log.reduce((s, r) => s + r.ms, 0),
  };
  const slowest = [...speeches].sort((a, b) => b.latencyMs - a.latencyMs)[0];
  const criticalPath = [
    `scenario ${Math.round(timing.scenarioMs ?? 0)} ms (sequential, first)`,
    `then in PARALLEL: image ${Math.round(timing.imageMs ?? 0)} ms | opinions ${Math.round(timing.opinionStageMs ?? 0)} ms (two generations in parallel ${Math.round(timing.opinionGenerationMs)} ms, then checker ${Math.round(timing.checkerMs ?? 0)} ms) => stage ${Math.round(timing.parallelStageMs ?? 0)} ms`,
    `then sequentially: opening A ${Math.round(openingMs.A)} ms, opening B ${Math.round(openingMs.B)} ms, 8 turns ${Math.round((timing.turnMs as number[]).reduce((a, b) => a + b, 0))} ms, judge ${Math.round(judgeMs)} ms`,
    `slowest debate step: sequence ${slowest.sequence} (Agent ${slowest.side}) ${Math.round(slowest.latencyMs)} ms`,
    `preparation ${Math.round(timing.preparationMs)} ms + debate ${Math.round(timing.debateMs)} ms + judge ${Math.round(judgeMs)} ms = end-to-end ${Math.round(timing.totalWallMs)} ms (sum of all model durations ${Math.round(timing.sumOfModelDurationsMs)} ms; the difference is the overlap)`,
  ];
  const kinds: Record<string, number> = {};
  for (const m of Object.values(audience.meta)) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
  const audienceMetrics = { total: subs.length, bySide, kinds, schedule: audience.schedule, clusters: Object.fromEntries(Object.entries(audience.clusters).filter(([n]) => /dup|para/.test(n)).map(([n, ids]) => [n, ids.length])), perTurn: (turns as { debateTurn: number; side: string; eligibleCumulative: number; analysis?: { accounting: { briefedPlayers: number; validated: { players: number }; unsafe: { players: number }; quarantined: { wordings: number }; missing: { wordings: number }; unknownIds: number }; rejected: number } }[]).map((t) => ({ turn: t.debateTurn, side: t.side, eligible: t.eligibleCumulative, briefedPlayers: t.analysis?.accounting.briefedPlayers, validatedPlayers: t.analysis?.accounting.validated.players, unsafePlayers: t.analysis?.accounting.unsafe.players, quarantinedWordings: t.analysis?.accounting.quarantined.wordings, missingWordings: t.analysis?.accounting.missing.wordings, unknownIds: t.analysis?.accounting.unknownIds, rejected: t.analysis?.rejected })) };
  const hardFail = checks.some((c) => c.status === "fail");
  return finish(report({ ok: !hardFail, roundId, timing, criticalPath, audience: audienceMetrics, verdict: { winner: v.winner, scores: v.scores, overall: v.overall }, ...(imageFile ? {} : {}) }));
}

function renderMarkdown(r: CompleteGameReport): string {
  const L: string[] = [`# Complete-game benchmark ${r.ok ? "PASSED" : "FAILED"}${r.failedStage ? ` at ${r.failedStage}` : ""}`, ""];
  if (r.error) L.push(`Error: ${r.error}`, "");
  L.push(`Seed ${r.seed}. Requests: ${r.requests.claude}/${r.requests.caps.claude} Claude, ${r.requests.image}/${r.requests.caps.image} image. Estimated Claude cost $${r.usage.estimatedClaudeUsd.toFixed(4)} (assumed $2/$10 per million tokens), image ${r.usage.imageCostUsd !== undefined ? `$${r.usage.imageCostUsd} (reported)` : "cost not reported"}.`, "");
  if (r.criticalPath.length) L.push("## Timing and critical path", ...r.criticalPath.map((x) => `- ${x}`), "");
  L.push("## Requests", ...r.requests.log.map((q) => `- ${q.kind} (${q.stage}) ${Math.round(q.ms)} ms${q.inputTokens !== undefined ? `, tokens ${q.inputTokens}/${q.outputTokens}` : ""}${q.ok ? "" : ` FAILED ${q.error}`}`), "");
  L.push("## Checks", ...r.checks.map((c) => `- [${c.status.toUpperCase()}] ${c.name}${c.detail ? ` (${c.detail})` : ""}`), "");
  L.push("Simulated users test audience processing and scalability only; this is NOT a real 200-client multiplayer load test.");
  return L.join("\n");
}
