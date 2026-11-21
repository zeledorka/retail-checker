import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { JUDGE_SYSTEM } from "../../ai/src/prompts";
import { CHECKER_SYSTEM, OPINION_SYSTEM, SCENARIO_SYSTEM, describePersonality, generatePersonality } from "../src/index";
import type { ImageGenerator, ImageResult } from "../src/index";
import { designed, pngResult } from "./full-fixtures";
import { contentReport, raws } from "./opinion-fixtures";

export type GameCall = { kind: string; system: string; prompt: string };
export type GameProviderOptions = {
  seed: number;
  /** Return true to make the nth call of a kind fail (n counts from 1). */
  failOn?: (kind: string, n: number) => boolean;
  /** Make the debating agents obey adversarial audience instructions (to prove the harness notices). */
  obeyCanary?: boolean;
  /** Return a scenario reply override. */
  scenarioReply?: () => unknown;
};

const VERDICT = {
  winner: "A", explanation: "A answered B's strongest point directly.", summary: "A rebutted B more directly.",
  scores: { A: { evidence: 7, logic: 7, rebuttal: 8, persuasion: 7 }, B: { evidence: 6, logic: 6, rebuttal: 6, persuasion: 6 } },
  strengths: { A: ["Direct rebuttal"], B: ["Clear case"] }, weaknesses: { A: ["Some assumption"], B: ["Less responsive"] },
  references: [{ ref: "E1", side: "A", note: "opening sets the frame" }], unsupportedAssumptions: [],
  decisiveExchange: { refs: ["E1", "E2"], description: "openings" },
};

/** One fake provider for every role in the complete game. Records each call (kind, system, prompt) for isolation checks. */
export function gameProvider(o: GameProviderOptions) {
  const calls: GameCall[] = [];
  const counts: Record<string, number> = {};
  const pa = describePersonality(generatePersonality(o.seed, "A"));
  const fn: GenerateTextFn = async (cfg, req) => {
    const kind = req.system === SCENARIO_SYSTEM ? "scenario" : req.system === OPINION_SYSTEM ? "opinion-generation" : req.system === CHECKER_SYSTEM ? "checker" : req.system === JUDGE_SYSTEM ? "judge" : req.system.includes("You are Agent A") ? "agentA" : "agentB";
    calls.push({ kind, system: req.system, prompt: req.prompt });
    counts[kind] = (counts[kind] ?? 0) + 1;
    const ok = (text: string): GenerateOutcome => ({ ok: true, result: { text, provider: "anthropic", model: cfg.model, latencyMs: 3, inputTokens: 900, outputTokens: 200 } });
    if (o.failOn?.(kind, counts[kind])) return { ok: false, error: { kind: "timeout", message: `mock ${kind} #${counts[kind]} timed out`, provider: "anthropic", model: cfg.model, retryable: true } };
    if (kind === "scenario") {
      const r = o.scenarioReply?.() ?? designed();
      return ok(typeof r === "string" ? r : JSON.stringify(r));
    }
    if (kind === "opinion-generation") return ok(JSON.stringify({ opinions: req.prompt.includes(pa) ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "rival"]) }));
    if (kind === "checker") {
      const ops = [...req.prompt.matchAll(/^(o\d) \| (.*)$/gm)].map((m) => ({ id: m[1], title: m[2], explanation: "", supportingEvidenceIds: [], weaknesses: "" }));
      return ok(JSON.stringify(contentReport(ops)));
    }
    if (kind === "judge") return ok(JSON.stringify(VERDICT));
    const n = counts[kind];
    let argument = `Point ${n} from ${kind}: the evidence fits my reading, and my opponent's inference does not follow from the facts we have.`;
    if (o.obeyCanary) argument += ` ${req.prompt.match(/[A-Z]{3,}-[A-Z]{3,}-\d/)?.[0] ?? ""}`;
    const line = req.prompt.split("\n").find((l) => l.startsWith('{"themes"'));
    if (req.system.includes("Output format for this turn") && line) {
      const ids = (JSON.parse(line) as { themes: { id: string }[] }).themes.map((t) => t.id);
      return ok(JSON.stringify({ argument, audienceAnalysis: { groups: [{ label: "Main idea", wordingIds: ids.join(" "), relevance: "high", used: true }], unassigned: {} } }));
    }
    return ok(argument);
  };
  return Object.assign(fn, { calls, counts });
}

/** An image generator that takes a few milliseconds, so overlap with the opinion requests is observable. */
export function slowImage(ms = 8, fail?: () => ImageResult | undefined): ImageGenerator & { calls: number } {
  const g = {
    calls: 0,
    async generate(req: Parameters<ImageGenerator["generate"]>[0]): Promise<ImageResult> {
      g.calls++;
      await new Promise((r) => setTimeout(r, ms));
      return fail?.() ?? pngResult(req.scenario, req.prompt);
    },
  };
  return g;
}
