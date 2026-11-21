import { z } from "zod";
import { PREPARED_CASES } from "./prepared-cases";
import type { ScenarioCase } from "./types";
import type { ScenarioInput } from "./opinion-types";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "id must be a lower-case slug (letters, digits, - _)");

export const scenarioInputSchema = z.object({
  id: slug,
  title: text(3, 80),
  description: text(40, 1200),
  evidence: z.array(z.object({ id: slug, text: text(10, 300) })).min(3).max(8),
  imagePrompt: text(20, 600).optional(),
  imagePath: z.string().regex(/^[A-Za-z0-9_\-./:]+$/).max(300).optional(),
});

export type ScenarioInputValidation = { ok: true; value: ScenarioInput } | { ok: false; errors: string[] };

/** The shared scenario every agent and the checker receives: case, numbered public evidence with stable ids, no interpretations. */
export function validateScenarioInput(raw: unknown): ScenarioInputValidation {
  const p = scenarioInputSchema.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`) };
  const ids = p.data.evidence.map((e) => e.id);
  const errors: string[] = [];
  if (new Set(ids).size !== ids.length) errors.push("evidence ids must be unique");
  const texts = p.data.evidence.map((e) => e.text.toLowerCase());
  if (new Set(texts).size !== texts.length) errors.push("evidence items must be unique");
  return errors.length ? { ok: false, errors } : { ok: true, value: p.data };
}

/** Adapts a prepared case to a scenario-only input: evidence gets stable ids e1, e2, ... and the old candidate interpretations are DROPPED. */
export function toScenarioInput(c: ScenarioCase): ScenarioInput {
  return { id: c.id, title: c.title, description: c.description, evidence: c.evidence.map((text, k) => ({ id: `e${k + 1}`, text })), imagePrompt: c.imagePrompt, ...(c.imagePath ? { imagePath: c.imagePath } : {}) };
}

/** The six prepared cases as scenario-only inputs (historical candidate lists stay in PREPARED_CASES and in validation/). */
export const PREPARED_SCENARIOS: ScenarioInput[] = PREPARED_CASES.map(toScenarioInput);
