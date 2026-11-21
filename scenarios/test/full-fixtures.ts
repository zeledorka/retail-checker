import type { GenerateOutcome, GenerateTextFn } from "../../ai/src/index";
import { createMockChecker, createMockGenerator, decodeImageResponse } from "../src/index";
import type { ImageGenerator, ImageResult, ScenarioInput } from "../src/index";
import { contentReport, raws } from "./opinion-fixtures";

export const EVIDENCE = [
  "The loading door was locked and its log shows no opening after 4 p.m.",
  "The inventory scanner recorded a transfer for the keg at 6:10 p.m.",
  "A delivery van was parked outside the neighbouring unit that afternoon.",
  "The cold room, normally empty on Fridays, had its light left on.",
  "Two staff members each say the other usually handles keg moves.",
];
export const DESIGNS = [
  { label: "Deliberate relocation", mechanism: "A colleague deliberately moved the keg to the cold room to protect a surprise order." },
  { label: "Delivery mix-up", mechanism: "A courier misread the paperwork and collected the keg for the neighbouring unit." },
  { label: "Scanner glitch", mechanism: "The stock scanner logged a false transfer after a software update, while the keg never moved." },
];
export const designed = (o: Record<string, unknown> = {}) => ({
  designs: DESIGNS, id: "missing-keg", title: "The Keg That Moved", setting: "a small brewery",
  description: "At closing time on Friday the brewery's biggest keg was gone from its rack, though the loading door was locked all evening. Nobody on shift remembers moving it.",
  evidence: EVIDENCE, imagePrompt: "A quiet brewery interior at dusk with an empty keg rack, a closed loading door and a clipboard on a nearby table, warm low light", ...o,
});
export const ok = (text: string): GenerateOutcome => ({ ok: true, result: { text, provider: "anthropic", model: "claude-sonnet-5-5", latencyMs: 5, inputTokens: 700, outputTokens: 500 } });
/** A scenario writer: every call returns a valid case whose id depends on the variety token in the prompt. */
export function scenarioWriter(replies: (n: number, prompt: string) => unknown = () => designed()) {
  const prompts: string[] = [];
  const fn: GenerateTextFn = async (_c, req) => {
    prompts.push(req.prompt);
    const r = replies(prompts.length - 1, req.prompt);
    return ok(typeof r === "string" ? r : JSON.stringify(r));
  };
  return Object.assign(fn, { prompts });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
export const PNG_B64 = PNG.toString("base64");
export const pngResult = (scenario: ScenarioInput, prompt = "p"): ImageResult => {
  const d = decodeImageResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }], usage: { cost: 0.031, completion_tokens: 1120, total_tokens: 1120 } }, { model: "google/gemini-3.1-flash-lite-image", prompt, scenarioId: scenario.id });
  if (!d.ok) throw new Error("fixture");
  return { ok: true, asset: d.asset, telemetry: { model: "google/gemini-3.1-flash-lite-image", latencyMs: 3, costUsd: d.usage?.cost, completionTokens: 1120 } };
};
export function mockImage(fn?: (n: number) => ImageResult | undefined) {
  const calls: { scenario: ScenarioInput; prompt: string }[] = [];
  const g: ImageGenerator & { calls: typeof calls } = { calls, async generate(req) { calls.push(req); return fn?.(calls.length - 1) ?? pngResult(req.scenario, req.prompt); } };
  return g;
}
export const mockOpinions = () => createMockGenerator((r) => (r.side === "A" ? raws(["outsider", "staged", "loan"]) : raws(["insider", "maintenance", "rival"])));
export const mockChecker = () => createMockChecker(({ opinions }) => contentReport(opinions));
