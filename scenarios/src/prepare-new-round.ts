import type { GenerateTextFn, Scenario } from "../../ai/src/index";
import { buildImagePrompt, saveImageLocally, toImageInfo } from "./image";
import type { ImageAsset, ImageGenerator, ImageInfo, ImageResult, ImageTelemetry } from "./image";
import { PREPARED_SCENARIOS } from "./scenario-input";
import { generateNewScenario } from "./scenario-design";
import type { ScenarioDesign } from "./scenario-design";
import { prepareScenario } from "./prepare-opinions";
import { hashSeed, mulberry32 } from "./personality";
import type { CallTelemetry, FinalSelectionOptions, OpinionChecker, OpinionGenerator, OpinionPrepareFailure, OpinionPrepareSuccess, ScenarioInput, StageError } from "./opinion-types";

/**
 * Full pre-round preparation, run BEFORE the timed round:
 *   1. one Claude request writes a new scenario (public case + private designs), validated locally;
 *   2. in PARALLEL: one OpenRouter image request (public facts only) and `prepareScenario` (2 opinion requests, then 1 blind checker request, then local selection);
 *   3. the result is returned only when scenario, image and the locked opposing pair all exist.
 * Normal path = 5 provider requests, two of which overlap. Retries are bounded: if the opinions fail (generation, checker, no credible pair) a NEW
 * scenario is written (`maxScenarioAttempts`, default 2 = one retry); a failed scenario is never reused by forcing a pair. If only the image fails
 * it is retried (`imageRetries`, default 1, image request only) and the opinion requests are never repeated. Optional last resort:
 * `fallbackToPrepared` runs the existing opinion pipeline on a prepared case (no generated image; reported honestly as a fallback).
 */
export type PrepareNewRoundOptions = {
  seed: number;
  /** Anthropic text function for the scenario writer (the AI module's `generateText`). */
  generate: GenerateTextFn;
  generator: OpinionGenerator;
  checker: OpinionChecker;
  imageGenerator: ImageGenerator;
  recentTitles?: string[];
  maxScenarioAttempts?: number;
  imageRetries?: number;
  fallbackToPrepared?: boolean;
  fallbackAttempts?: number;
  selection?: Partial<Omit<FinalSelectionOptions, "seed">>;
  /** Extra checker requests after an INVALID checker reply (default 1, as in prepareScenario). Set 0 for a strict request cap. */
  checkerRetries?: number;
  /** Local development only: also write the image file here (git-ignored folder). Developer 3 uploads `image.bytes` instead. */
  saveImagesTo?: string;
};

export type RoundTiming = { scenarioMs?: number; imageMs?: number; opinionsMs?: number; parallelMs?: number; totalMs: number };
export type AttemptLog = { attempt: number; seed: number; stage: "scenario" | "opinions" | "image" | "ok" | "fallback"; ok: boolean; message?: string; scenarioId?: string; timing: Partial<RoundTiming>; llmCalls: number };
export type RoundRequests = { scenario: number; image: number; opinionGeneration: number; checker: number; total: number };
export type RoundUsage = { scenario?: CallTelemetry; opinionGeneration: { A?: CallTelemetry; B?: CallTelemetry }; checker?: CallTelemetry; image?: ImageTelemetry; estimatedClaudeUsd: number; imageCostUsd?: number };

export type PreparedRound = {
  ok: true;
  source: "generated" | "fallback";
  /** Exactly the input of `startRound({ roundId, scenario })`. */
  scenario: Scenario;
  /** Safe for the frontend and storage: no personalities, designs, unselected opinions or diagnostics. Contains no image bytes. */
  publicCase: { scenarioId: string; title: string; description: string; evidence: { id: string; text: string }[]; interpretationA: string; interpretationB: string; image: ImageInfo | null; imagePath?: string; localImagePath?: string };
  /** Binary image for Developer 3 to upload; null only for a fallback case without an image. Never serialise this into AI round state. */
  image: ImageAsset | null;
  /** SERVER-ONLY. Never give it to the judge, the debating agents or the browser. */
  server: { seed: number; scenarioSeed: number; scenarioId: string; design?: ScenarioDesign; opinions: OpinionPrepareSuccess["meta"]; imageStatus: "generated" | "fallback_without_image"; models: { scenario?: string; opinions?: string; checker?: string; image?: string }; timing: RoundTiming; requests: RoundRequests; usage: RoundUsage; attempts: AttemptLog[] };
};
export type PrepareNewRoundFailure = {
  ok: false;
  stage: "scenario" | "opinions" | "image" | "fallback";
  message: string;
  attempts: AttemptLog[];
  requests: RoundRequests;
  timing: RoundTiming;
  /** When only the image failed: the finished scenario and opinions, so a caller can retry the image alone instead of repeating the opinion requests. */
  preserved?: { scenario: ScenarioInput; opinions: OpinionPrepareSuccess; imageError: { code: string; message: string } };
  lastError?: StageError | { code: string; message: string };
};
export type PrepareNewRoundResult = PreparedRound | PrepareNewRoundFailure;

const CLAUDE_PRICE = { input: 2, output: 10 }; // USD per million tokens: an ESTIMATE for Sonnet 5.5, not a provider-reported charge
const usd = (t?: CallTelemetry) => (((t?.inputTokens ?? 0) * CLAUDE_PRICE.input + (t?.outputTokens ?? 0) * CLAUDE_PRICE.output) / 1e6);
const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
};
const publicOnly = (s: ScenarioInput): ScenarioInput => ({ id: s.id, title: s.title, description: s.description, evidence: s.evidence.map((e) => ({ ...e })) });

function usageOf(scenarioT: CallTelemetry | undefined, op: OpinionPrepareSuccess["meta"], image?: ImageTelemetry): RoundUsage {
  const gen = op.telemetry.generation;
  const est = usd(scenarioT) + usd(gen.A) + usd(gen.B) + usd(op.telemetry.checker);
  return { scenario: scenarioT, opinionGeneration: { A: gen.A, B: gen.B }, checker: op.telemetry.checker, image, estimatedClaudeUsd: est, imageCostUsd: image?.costUsd };
}

function assemble(args: { source: "generated" | "fallback"; seed: number; scenarioSeed: number; scenario: ScenarioInput; design?: ScenarioDesign; op: OpinionPrepareSuccess; image: ImageAsset | null; imageTelemetry?: ImageTelemetry; scenarioT?: CallTelemetry; timing: RoundTiming; requests: RoundRequests; attempts: AttemptLog[]; localImagePath?: string }): PreparedRound {
  const { scenario: s, op } = args;
  return {
    ok: true,
    source: args.source,
    scenario: op.scenario,
    publicCase: { scenarioId: s.id, title: s.title, description: s.description, evidence: s.evidence.map((e) => ({ ...e })), interpretationA: op.scenario.interpretationA, interpretationB: op.scenario.interpretationB, image: args.image ? toImageInfo(args.image) : null, ...(s.imagePath ? { imagePath: s.imagePath } : {}), ...(args.localImagePath ? { localImagePath: args.localImagePath } : {}) },
    image: args.image,
    server: {
      seed: args.seed,
      scenarioSeed: args.scenarioSeed,
      scenarioId: s.id,
      design: args.design,
      opinions: op.meta,
      imageStatus: args.image ? "generated" : "fallback_without_image",
      models: { scenario: args.scenarioT?.model, opinions: op.meta.telemetry.generation.A?.model, checker: op.meta.telemetry.checker?.model, image: args.imageTelemetry?.model },
      timing: args.timing,
      requests: args.requests,
      usage: usageOf(args.scenarioT, op.meta, args.imageTelemetry),
      attempts: args.attempts,
    },
  };
}

export async function prepareNewRound(o: PrepareNewRoundOptions): Promise<PrepareNewRoundResult> {
  const t0 = Date.now();
  const maxAttempts = Math.max(1, o.maxScenarioAttempts ?? 2);
  const requests: RoundRequests = { scenario: 0, image: 0, opinionGeneration: 0, checker: 0, total: 0 };
  const attempts: AttemptLog[] = [];
  const total = () => ({ totalMs: Date.now() - t0 });
  const count = (op: { llmCalls: number }) => {
    requests.opinionGeneration += 2;
    requests.checker += op.llmCalls - 2;
  };
  let last: PrepareNewRoundFailure["lastError"];
  let lastStage: PrepareNewRoundFailure["stage"] = "scenario";
  let lastMessage = "no attempt was made";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const scenarioSeed = o.seed + attempt * 7919;
    const sTimed = await timed(() => generateNewScenario({ generate: o.generate, seed: scenarioSeed, recentTitles: o.recentTitles }));
    requests.scenario++;
    const sg = sTimed.value;
    if (!sg.ok) {
      lastStage = "scenario";
      lastMessage = sg.error.message;
      last = sg.error;
      attempts.push({ attempt, seed: scenarioSeed, stage: "scenario", ok: false, message: sg.error.message, timing: { scenarioMs: sTimed.ms }, llmCalls: 1 });
      continue;
    }
    const scenario = sg.scenario;
    // Image and opinion selection run concurrently; the image sees public facts only.
    const par0 = Date.now();
    const imageRun = timed(() => o.imageGenerator.generate({ scenario, prompt: buildImagePrompt(scenario) }));
    const opinionRun = timed(() => prepareScenario({ scenario: publicOnly(scenario), seed: scenarioSeed, generator: o.generator, checker: o.checker, selection: o.selection, checkerRetries: o.checkerRetries }));
    const [img, opRes] = await Promise.all([imageRun, opinionRun]);
    const parallelMs = Date.now() - par0;
    requests.image++;
    const op = opRes.value;
    const base = { scenarioMs: sTimed.ms, imageMs: img.ms, opinionsMs: opRes.ms, parallelMs };
    if (!op.ok) {
      requests.opinionGeneration += op.stage === "input" ? 0 : 2;
      requests.checker += Math.max(0, op.llmCalls - 2);
      const f = op as OpinionPrepareFailure;
      lastStage = "opinions";
      lastMessage = f.message;
      last = f.error ?? { code: f.stage, message: f.message };
      attempts.push({ attempt, seed: scenarioSeed, stage: "opinions", ok: false, message: `${f.stage}: ${f.message}`, scenarioId: scenario.id, timing: base, llmCalls: f.llmCalls + 2 });
      continue; // a new scenario is written; this one is never forced into a debate
    }
    count(op.meta);
    let image: ImageResult = img.value;
    let imageMs = img.ms;
    for (let r = 0; !image.ok && image.error.retryable && r < (o.imageRetries ?? 1); r++) {
      const again = await timed(() => o.imageGenerator.generate({ scenario, prompt: buildImagePrompt(scenario) }));
      requests.image++;
      image = again.value;
      imageMs += again.ms; // only the image request is repeated; the opinions are kept
    }
    requests.total = requests.scenario + requests.image + requests.opinionGeneration + requests.checker;
    if (!image.ok) {
      attempts.push({ attempt, seed: scenarioSeed, stage: "image", ok: false, message: image.error.message, scenarioId: scenario.id, timing: { ...base, imageMs }, llmCalls: op.meta.llmCalls + 1 });
      return { ok: false, stage: "image", message: `the image could not be generated: ${image.error.message}`, attempts, requests, timing: total(), preserved: { scenario, opinions: op, imageError: { code: image.error.code, message: image.error.message } }, lastError: { code: image.error.code, message: image.error.message } };
    }
    const localImagePath = o.saveImagesTo ? saveImageLocally(image.asset, o.saveImagesTo) : undefined;
    const timing: RoundTiming = { ...base, imageMs, totalMs: Date.now() - t0 };
    attempts.push({ attempt, seed: scenarioSeed, stage: "ok", ok: true, scenarioId: scenario.id, timing, llmCalls: op.meta.llmCalls + 1 });
    return assemble({ source: "generated", seed: o.seed, scenarioSeed, scenario, design: sg.design, op, image: image.asset, imageTelemetry: image.telemetry, scenarioT: sg.telemetry, timing, requests, attempts, localImagePath });
  }

  if (o.fallbackToPrepared) {
    const rand = mulberry32(hashSeed("fallback-case", o.seed));
    const order = [...PREPARED_SCENARIOS].sort(() => rand() - 0.5);
    for (const [k, s] of order.slice(0, o.fallbackAttempts ?? 2).entries()) {
      const fb = await timed(() => prepareScenario({ scenario: publicOnly(s), seed: o.seed + 104729 * (k + 1), generator: o.generator, checker: o.checker, selection: o.selection, checkerRetries: o.checkerRetries }));
      const op = fb.value;
      if (op.ok) {
        count(op.meta);
        requests.total = requests.scenario + requests.image + requests.opinionGeneration + requests.checker;
        const timing: RoundTiming = { opinionsMs: fb.ms, totalMs: Date.now() - t0 };
        attempts.push({ attempt: attempts.length, seed: o.seed, stage: "fallback", ok: true, scenarioId: s.id, timing, llmCalls: op.meta.llmCalls });
        return assemble({ source: "fallback", seed: o.seed, scenarioSeed: o.seed, scenario: s, op, image: null, timing, requests, attempts });
      }
      requests.opinionGeneration += 2;
      requests.checker += Math.max(0, op.llmCalls - 2);
      attempts.push({ attempt: attempts.length, seed: o.seed, stage: "fallback", ok: false, message: op.message, scenarioId: s.id, timing: { opinionsMs: fb.ms }, llmCalls: op.llmCalls });
      lastStage = "fallback";
      lastMessage = op.message;
    }
  }
  requests.total = requests.scenario + requests.image + requests.opinionGeneration + requests.checker;
  return { ok: false, stage: lastStage, message: lastMessage, attempts, requests, timing: total(), lastError: last };
}
