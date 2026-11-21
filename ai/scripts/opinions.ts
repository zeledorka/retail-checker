// Independent-opinion and agreement-check helpers for the manual all-Claude benchmark (test code only).
import { z } from "zod";

export const OPINION_SYSTEM = [
  "You are examining an ambiguous scenario.",
  "Independently determine what you think most likely happened based only on the supplied information.",
  "Choose your own interpretation without being given predefined alternatives.",
  "Explain your conclusion briefly, using available evidence.",
  "Distinguish observations from assumptions. Do not invent additional evidence.",
  "You may express uncertainty, but you must provide your leading interpretation.",
  "Do not attempt to agree or disagree with another agent.",
  "Keep your explanation under 60 words.",
  "",
  'Reply with ONLY a JSON object, no markdown: {"interpretation":"short description of your chosen explanation","reasoning":"your brief justification (under 60 words)","confidence":0-100 integer}',
].join("\n");

export function opinionPrompt(description: string, evidence: string[]): string {
  return `SCENARIO:\n${description}\n\nOBSERVATIONS:\n${evidence.map((e) => `- ${e}`).join("\n")}`;
}

function extractJson(raw: string): { ok: true; data: unknown } | { ok: false; reason: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, reason: "no JSON object in output" };
  try {
    return { ok: true, data: JSON.parse(raw.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: "output is not valid JSON" };
  }
}

const opinionSchema = z.object({
  interpretation: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
  confidence: z.coerce.number().int().min(0).max(100),
});
export type Opinion = z.infer<typeof opinionSchema>;

export function parseOpinion(raw: string): { ok: true; value: Opinion } | { ok: false; reason: string } {
  const j = extractJson(raw);
  if (!j.ok) return j;
  const r = opinionSchema.safeParse(j.data);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: `validation failed: ${r.error.issues[0]?.message}` };
}

// One harness call (not part of the game engine): decides whether the two independent opinions truly differ,
// because exact string comparison cannot. It never edits or regenerates an opinion.
export const COMPARE_SYSTEM = [
  "You compare two independently written interpretations of the same ambiguous situation.",
  "Decide whether they are MEANINGFULLY DIFFERENT explanations (a different underlying cause or story), or essentially the same conclusion in different words or with different emphasis.",
  "Do not decide which is better or more likely.",
  'Reply with ONLY a JSON object, no markdown: {"disagree":true|false,"reason":"one short sentence"}',
].join("\n");

export const comparePrompt = (first: string, second: string) => `INTERPRETATION 1: ${first}\n\nINTERPRETATION 2: ${second}`;

const comparisonSchema = z.object({ disagree: z.boolean(), reason: z.string().trim().min(1) });
export function parseComparison(raw: string): { ok: true; disagree: boolean; reason: string } | { ok: false; reason: string } {
  const j = extractJson(raw);
  if (!j.ok) return j;
  const r = comparisonSchema.safeParse(j.data);
  return r.success ? { ok: true, ...r.data } : { ok: false, reason: `validation failed: ${r.error.issues[0]?.message}` };
}
