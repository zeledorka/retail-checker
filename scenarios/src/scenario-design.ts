import { z } from "zod";
import type { GenerateTextFn, ModelConfig } from "../../ai/src/index";
import { hashSeed, mulberry32 } from "./personality";
import { similarity } from "./schema";
import { validateScenarioInput } from "./scenario-input";
import type { CallTelemetry, ScenarioInput, StageError } from "./opinion-types";

/**
 * Live scenario generation: ONE Sonnet 5.5 (low effort) request writes a complete new ambiguous case. The model first designs two or three
 * different causal explanations PRIVATELY ("designs"), then writes public evidence that supports several of them without settling any.
 * The designs are quality-control metadata only: they never reach the agents, checker, judge or frontend, and the image prompt is built
 * from public facts only. A designer's claim of balance proves nothing; the independent opinion checker remains the real gate.
 */
export const SCENARIO_MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5-5", maxOutputTokens: 2500, timeoutMs: 45_000, maxRetries: 0, effort: "low" };

/** Seeded variety hints (examples of kinds of situation, not templates and not a closed list: the model may deviate). */
export const SITUATION_HINTS = ["a mysterious disappearance", "a suspicious transaction", "an unexplained accident", "a strange security-camera event", "an unusual workplace incident", "a disputed delivery", "a property mystery", "an unexpected technical failure", "a possible deception", "a misunderstanding involving several people"];
export const SETTING_HINTS = ["a regional museum", "a small hospital ward", "a harbour warehouse", "a village school", "a hotel at night", "a research laboratory", "a family restaurant", "a public library", "a farm cooperative", "a community theatre", "a bus depot", "a bakery", "an apartment block", "a ferry terminal", "a sports club", "a recycling plant", "a radio station", "a vineyard", "a data centre", "a ski lodge", "a fishing boat", "a university lecture hall"];

/** Hard validation limits (characters). Every one is within the downstream limits of validateScenarioInput and startRound(). */
export const SCENARIO_LIMITS = { title: 80, setting: 160, description: 700, evidence: 300, mechanism: 400, label: 80, imagePrompt: 600 } as const;
/** What the prompt asks the model to stay within: deliberately below the hard limits, so a slightly long reply is still accepted. */
export const SCENARIO_ASKED = { title: 60, setting: 120, description: 500, evidence: 240, mechanism: 300, label: 60, imagePrompt: 450 } as const;

export const SCENARIO_SYSTEM = [
  "You write ONE new ambiguous case for a courtroom-style debate game. Output ONLY a JSON object, no markdown.",
  "Work in this order. First design two or three genuinely different causal explanations of what happened (for example an intentional act, an accident, a technical or procedural mistake; these are only examples) and put them in \"designs\". Then write the public case and evidence so that they could support SEVERAL of those explanations without proving any of them.",
  "Public evidence rules: 3 to 6 short plain observations (one sentence each), relevant, consistent with each other, none stating a culprit, motive, cause or outcome as fact. Make some clues readable in more than one way. Nobody is certain who did what or why.",
  "The case must be quick to understand: a title, a description of 2-3 sentences saying what happened and why it is puzzling, ordinary and non-violent (no deaths, no real people or organisations). Do not make it about theft, fraud or a missing object unless the hint calls for it. Be specific and fresh, not generic.",
  "Never mention the designs, 'explanations', 'theories' or 'interpretations' in public fields.",
  "imagePrompt: a cinematic landscape scene prompt describing ONLY the setting and the visible facts of the public evidence. No identifiable faces, no text or signs, no person caught in the act, no culprit, no motive, and nothing the written evidence does not state.",
  `Length limits in characters: title at most ${SCENARIO_ASKED.title}; setting (a short phrase) at most ${SCENARIO_ASKED.setting}; description at most ${SCENARIO_ASKED.description}; each evidence item at most ${SCENARIO_ASKED.evidence}; each design label at most ${SCENARIO_ASKED.label} and mechanism at most ${SCENARIO_ASKED.mechanism}; imagePrompt at most ${SCENARIO_ASKED.imagePrompt}. The id is a lower-case slug of at most 40 characters.`,
  'JSON shape: {"designs":[{"label":"2-5 words","mechanism":"one sentence: the private causal explanation"}],"id":"lower-case-slug","title":"","setting":"","description":"","evidence":["3 to 6 observations"],"imagePrompt":""}',
].join("\n");

export type ScenarioDesign = { designs: { label: string; mechanism: string }[]; setting: string; hint: { situation: string; setting: string }; recentAvoided: string[] };

export function pickHints(seed: number): { situation: string; setting: string } {
  const rand = mulberry32(hashSeed("scenario-hints", seed));
  return { situation: SITUATION_HINTS[Math.floor(rand() * SITUATION_HINTS.length)], setting: SETTING_HINTS[Math.floor(rand() * SETTING_HINTS.length)] };
}

export function buildScenarioPrompt(seed: number, recentTitles: string[] = []): string {
  const h = pickHints(seed);
  return [
    `Write one new case. Inspiration (loose, you may deviate): ${h.situation}, around ${h.setting}.`,
    recentTitles.length ? `Recently used (do not repeat these stories, even with new names or places): ${recentTitles.slice(-8).join("; ")}.` : "",
    `Variety token: ${seed}.`,
    "Return the JSON now.",
  ].filter(Boolean).join("\n");
}

const t = (min: number, max: number) => z.string().trim().min(min).max(max);
const designedSchema = z.object({
  designs: z.array(z.object({ label: t(3, SCENARIO_LIMITS.label), mechanism: t(25, SCENARIO_LIMITS.mechanism) })).min(2).max(3),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  title: t(3, SCENARIO_LIMITS.title),
  setting: t(3, SCENARIO_LIMITS.setting),
  description: t(40, SCENARIO_LIMITS.description),
  evidence: z.array(t(10, SCENARIO_LIMITS.evidence)).min(3).max(6),
  imagePrompt: t(20, SCENARIO_LIMITS.imagePrompt),
});

const VERDICT = /\b(confess\w*|admitted|prov(e|es|ed|ing|en)|proof|guilty|culprit|caught (red-handed|on camera)|obviously|clearly (shows|proves))\b/i;
const IMAGE_FORBIDDEN = /\b(thief|culprit|criminal|burglar|escaping|fleeing|stealing|sneaking|hiding the|caught)\b/i;
const META = /\b(interpretation|explanation|theory|theories|design)s?\b/i;

export type DesignValidation = { ok: true; scenario: ScenarioInput; design: Omit<ScenarioDesign, "hint" | "recentAvoided"> } | { ok: false; errors: string[] };

/** Validates a designer reply: shape, evidence count/ids/duplicates, public text limits, distinct private designs, and no leakage of designs or verdicts into public fields. */
export function validateDesignedScenario(raw: unknown, seed: number): DesignValidation {
  const p = designedSchema.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`) };
  const d = p.data;
  const errors: string[] = [];
  const publicItems = [d.title, d.description, ...d.evidence, d.imagePrompt];
  for (const [i, a] of d.designs.entries()) {
    for (const [j, b] of d.designs.entries()) if (j > i && similarity(a.mechanism, b.mechanism) >= 0.5) errors.push(`designs ${i + 1} and ${j + 1} are near-paraphrases`);
    for (const item of publicItems) {
      const low = item.toLowerCase();
      if (low.includes(a.mechanism.toLowerCase()) || (a.label.length >= 10 && low.includes(a.label.toLowerCase())) || similarity(a.mechanism, item) >= 0.5) errors.push(`private design ${i + 1} leaks into public text: "${item.slice(0, 60)}"`);
    }
  }
  for (const e of [d.description, ...d.evidence]) {
    if (VERDICT.test(e)) errors.push(`public text states a verdict: "${e.slice(0, 60)}"`);
    if (META.test(e)) errors.push(`public text refers to explanations or designs: "${e.slice(0, 60)}"`);
  }
  if (IMAGE_FORBIDDEN.test(d.imagePrompt)) errors.push("imagePrompt depicts an act, culprit or escape");
  if (/\b(text|sign|label|caption)s?\b.*\b(reads|saying|says)\b/i.test(d.imagePrompt)) errors.push("imagePrompt asks for written text");
  if (errors.length) return { ok: false, errors };
  // Unique id per request: the slug the model chose plus a short seeded suffix.
  const id = `${d.id.slice(0, 32)}-${hashSeed("scenario-id", seed, d.id).toString(36).slice(0, 4)}`;
  const input = validateScenarioInput({ id, title: d.title, description: d.description, evidence: d.evidence.map((text, k) => ({ id: `e${k + 1}`, text })), imagePrompt: d.imagePrompt });
  if (!input.ok) return { ok: false, errors: input.errors };
  return { ok: true, scenario: input.value, design: { designs: d.designs, setting: d.setting } };
}

export type ScenarioGenResult =
  | { ok: true; scenario: ScenarioInput; design: ScenarioDesign; telemetry?: CallTelemetry }
  | { ok: false; error: StageError; telemetry?: CallTelemetry };

export async function generateNewScenario(input: { generate: GenerateTextFn; seed: number; recentTitles?: string[]; model?: ModelConfig }): Promise<ScenarioGenResult> {
  const out = await input.generate(input.model ?? SCENARIO_MODEL, { system: SCENARIO_SYSTEM, prompt: buildScenarioPrompt(input.seed, input.recentTitles) });
  if (!out.ok) return { ok: false, error: { code: out.error.kind === "config" ? "config" : "model_error", message: out.error.message, retryable: out.error.retryable } };
  const { model, latencyMs, inputTokens, outputTokens } = out.result;
  const telemetry = { model, latencyMs, inputTokens, outputTokens };
  const s = out.result.text.indexOf("{");
  const e = out.result.text.lastIndexOf("}");
  let data: unknown;
  try {
    data = JSON.parse(out.result.text.slice(s, e + 1));
  } catch {
    return { ok: false, error: { code: "invalid_output", message: "the scenario reply is not valid JSON", retryable: true, raw: out.result.text }, telemetry };
  }
  const v = validateDesignedScenario(data, input.seed);
  if (!v.ok) return { ok: false, error: { code: "invalid_output", message: `invalid scenario: ${v.errors[0]}`, retryable: true, details: v.errors, raw: out.result.text }, telemetry };
  return { ok: true, scenario: v.scenario, design: { ...v.design, hint: pickHints(input.seed), recentAvoided: (input.recentTitles ?? []).slice(-8) }, telemetry };
}
