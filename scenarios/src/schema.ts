import { z } from "zod";
import type { ScenarioCase } from "./types";

/** Limits are tighter than ai/src/round.ts's startRound() limits, so every valid case is also a valid AI scenario. */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, "id must be a lower-case slug of 2-40 characters (letters, digits, - _)");

export const interpretationSchema = z.object({ id: slug, label: text(3, 60), description: text(25, 400) });
export const scenarioCaseSchema = z.object({
  id: slug,
  title: text(3, 80),
  description: text(40, 1200),
  evidence: z.array(text(10, 300)).min(3).max(6),
  interpretations: z.array(interpretationSchema).min(3).max(4),
  imagePrompt: text(20, 600),
  imagePath: z.string().regex(/^[A-Za-z0-9_\-./:]+$/).max(300).optional(),
});

const STOP = new Set("that this with from have were they their there which would could about into than then also been being only just when what while because someone something nothing after before over under the and for are was but not its his her who has had".split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
/** Word-overlap similarity of two descriptions (0..1). A rough guard against paraphrases of one conclusion, not a semantic test. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  const common = [...x].filter((w) => y.has(w)).length;
  return common / (x.size + y.size - common);
}
export const MAX_INTERPRETATION_SIMILARITY = 0.6;

export type CaseValidation = { ok: true; value: ScenarioCase } | { ok: false; errors: string[] };

/** Validates shape and the cross-field rules: unique ids and labels, no near-identical interpretations, no duplicate evidence. */
export function validateScenarioCase(raw: unknown): CaseValidation {
  const p = scenarioCaseSchema.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`) };
  const c = p.data;
  const errors: string[] = [];
  const ids = c.interpretations.map((i) => i.id);
  if (new Set(ids).size !== ids.length) errors.push("interpretation ids must be unique");
  const labels = c.interpretations.map((i) => i.label.toLowerCase());
  if (new Set(labels).size !== labels.length) errors.push("interpretation labels must be unique");
  for (let i = 0; i < c.interpretations.length; i++)
    for (let j = i + 1; j < c.interpretations.length; j++) {
      const s = similarity(c.interpretations[i].description, c.interpretations[j].description);
      if (s >= MAX_INTERPRETATION_SIMILARITY) errors.push(`interpretations ${ids[i]} and ${ids[j]} are near-paraphrases (word overlap ${s.toFixed(2)})`);
    }
  const ev = c.evidence.map((e) => e.toLowerCase());
  if (new Set(ev).size !== ev.length) errors.push("evidence items must be unique");
  return errors.length ? { ok: false, errors } : { ok: true, value: c };
}
