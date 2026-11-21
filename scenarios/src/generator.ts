import type { GenerateTextFn, ModelConfig } from "../../ai/src/index";
import { hashSeed, mulberry32 } from "./personality";
import { validateScenarioCase } from "./schema";
import type { ScenarioCase } from "./types";

/**
 * Batch scenario generation: one structured request per case (run in parallel), each reply validated. Run it BEFORE any live
 * debate (e.g. a script that stores the accepted cases); it is not part of the timed round. Status: only run with mocks so far.
 * Invalid replies are reported in `rejected`, never repaired by guessing and never retried automatically.
 */
export const GENERATOR_MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5-5", maxOutputTokens: 3000, timeoutMs: 60_000, maxRetries: 0, effort: "low" };

/** Bounded list of settings, only to keep a batch varied. Not personalities and not interpretations. */
export const SETTINGS = ["a regional museum", "a small hospital ward", "a harbour warehouse", "a village school", "a hotel at night", "a research laboratory", "a family restaurant", "a public library", "a farm cooperative", "a community theatre", "a bus depot", "a bakery", "an apartment block", "a ferry terminal", "a sports club", "a recycling plant"];

export const GENERATOR_SYSTEM = [
  "You write ambiguous cases for a debate game. Output ONLY one JSON object, no markdown.",
  "The case must be ordinary and non-violent (no deaths, no real people or organisations). Every evidence item is a plain, neutral observation.",
  "The evidence must genuinely support SEVERAL different readings and must NOT settle the case: do not state any motive, culprit or cause as fact.",
  "Give 4 candidate interpretations that are meaningfully different explanations (different cause, actor or mechanism), each defensible from the evidence and none a paraphrase of another.",
  'JSON shape: {"id":"slug","title":"","description":"2-3 sentences","evidence":["3 to 6 observations"],"interpretations":[{"id":"slug","label":"2-4 words","description":"one sentence"}],"imagePrompt":"a text-to-image prompt, no people\'s faces, no text in the image"}',
  "Slugs use lower-case letters, digits and hyphens only.",
].join("\n");

export function buildGenerationPrompt(setting: string, index: number): string {
  return `Write case number ${index + 1}. Setting: ${setting}. Choose a fresh, specific situation in that setting. Return the JSON now.`;
}

export type GenerationBatch = { cases: ScenarioCase[]; rejected: { index: number; setting: string; errors: string[] }[] };

export async function generateScenarioBatch(input: { generate: GenerateTextFn; count: number; seed: number; model?: ModelConfig }): Promise<GenerationBatch> {
  const rand = mulberry32(hashSeed("settings", input.seed));
  const pool = [...SETTINGS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const settings = Array.from({ length: input.count }, (_, k) => pool[k % pool.length]);
  const replies = await Promise.all(settings.map((setting, k) => input.generate(input.model ?? GENERATOR_MODEL, { system: GENERATOR_SYSTEM, prompt: buildGenerationPrompt(setting, k) })));
  const cases: ScenarioCase[] = [];
  const rejected: GenerationBatch["rejected"] = [];
  const seen = new Set<string>();
  for (const [k, r] of replies.entries()) {
    const fail = (errors: string[]) => rejected.push({ index: k, setting: settings[k], errors });
    if (!r.ok) {
      fail([`model error [${r.error.kind}]: ${r.error.message}`]);
      continue;
    }
    const s = r.result.text.indexOf("{");
    const e = r.result.text.lastIndexOf("}");
    let data: unknown;
    try {
      data = JSON.parse(r.result.text.slice(s, e + 1));
    } catch {
      fail(["reply is not valid JSON"]);
      continue;
    }
    const v = validateScenarioCase(data);
    if (!v.ok) fail(v.errors);
    else if (seen.has(v.value.id)) fail([`duplicate case id "${v.value.id}" in this batch`]);
    else {
      seen.add(v.value.id);
      cases.push(v.value);
    }
  }
  return { cases, rejected };
}
