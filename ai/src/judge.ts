import { z } from "zod";
import type { JudgeVerdict } from "./types";

const score = z.coerce.number().int().min(1).max(10);
const criteria = z.object({ evidence: score, logic: score, rebuttal: score, persuasion: score });

export const verdictSchema = z.object({
  winner: z.enum(["A", "B"]),
  explanation: z.string().trim().min(1),
  scores: z.object({ A: criteria, B: criteria }),
});

/** Extracts and validates the judge JSON. Tolerates code fences and surrounding prose. */
export function parseVerdict(raw: string): { ok: true; verdict: JudgeVerdict } | { ok: false; reason: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, reason: "no JSON object in judge output" };
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "judge output is not valid JSON" };
  }
  const parsed = verdictSchema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: `judge JSON failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const v = parsed.data;
  return { ok: true, verdict: { ...v, explanation: v.explanation.slice(0, 600) } };
}
