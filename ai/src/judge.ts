import { z } from "zod";
import type { CriterionScores, JudgeReference, JudgeVerdict, Side, TranscriptEntry } from "./types";

const score = z.coerce.number().int().min(0).max(10);
const criteria = z.object({ evidence: score, logic: score, rebuttal: score, persuasion: score });
const side = z.enum(["A", "B"]);
const short = (n: number) => z.string().trim().min(1).transform((s) => s.slice(0, n));
const perSide = (item: z.ZodType<string>) => z.object({ A: z.array(item).min(1).max(4), B: z.array(item).min(1).max(4) });

/** Base fields every verdict needs (the original contract; scores are now 0-10). */
export const verdictSchema = z.object({
  winner: side,
  explanation: z.string().trim().min(1),
  scores: z.object({ A: criteria, B: criteria }),
});

/** Full contract used by judgeDebate(): the evidence-based justification. */
const detailedSchema = verdictSchema.extend({
  summary: short(200).optional(),
  strengths: perSide(short(240)),
  weaknesses: perSide(short(240)),
  references: z.array(z.object({ ref: z.string(), side, note: short(240), quote: z.string().optional() })).max(10),
  unsupportedAssumptions: z.array(z.object({ side, ref: z.string().optional(), assumption: short(240) })).max(8).default([]),
  decisiveExchange: z.object({ refs: z.array(z.string()).max(6), description: short(400) }),
});

const total = (s: CriterionScores) => s.evidence + s.logic + s.rebuttal + s.persuasion;
const mean = (s: CriterionScores) => Math.round((total(s) / 4) * 10) / 10;

/**
 * The declared rule: higher total wins; on equal totals the higher rebuttal wins, then the higher evidence.
 * Returns undefined when those are all equal (the judge's own tie-break stands).
 */
export function ruleWinner(scores: Record<Side, CriterionScores>): Side | undefined {
  for (const pick of [total, (s: CriterionScores) => s.rebuttal, (s: CriterionScores) => s.evidence]) {
    const a = pick(scores.A);
    const b = pick(scores.B);
    if (a !== b) return a > b ? "A" : "B";
  }
  return undefined;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

export type JudgeEntryRef = Pick<TranscriptEntry, "side" | "text"> & { id: string };

/**
 * Extracts and validates the judge JSON. Tolerates code fences and surrounding prose.
 * Without `entries` only the base contract is checked (winner, explanation, 0-10 scores, winner rule).
 * With `entries` (the ids the judge was shown) the evidence-based justification is required and every reference is
 * validated: the id must exist, the side must match its speaker and a quote must appear in that entry. Invalid references
 * are dropped and listed in `verdict.validation`; at least one valid reference must remain.
 */
export function parseVerdict(raw: string, entries?: JudgeEntryRef[]): { ok: true; verdict: JudgeVerdict } | { ok: false; reason: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, reason: "no JSON object in judge output" };
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "judge output is not valid JSON" };
  }
  const parsed = (entries ? detailedSchema : verdictSchema).safeParse(data);
  if (!parsed.success) return { ok: false, reason: `judge JSON failed validation: ${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const v = parsed.data as z.infer<typeof detailedSchema>;
  const expected = ruleWinner(v.scores);
  if (expected && expected !== v.winner) return { ok: false, reason: `winner ${v.winner} contradicts the scores (totals A ${total(v.scores.A)} / B ${total(v.scores.B)}; rule says ${expected})` };
  const base: JudgeVerdict = { winner: v.winner, explanation: v.explanation.slice(0, 600), scores: v.scores, overall: { A: mean(v.scores.A), B: mean(v.scores.B) } };
  if (!entries) return { ok: true, verdict: base };

  const byId = new Map(entries.map((e) => [e.id, e]));
  const rejectedReferences: { ref: string; reason: string }[] = [];
  const references: JudgeReference[] = [];
  for (const r of v.references) {
    const id = r.ref.trim().toUpperCase();
    const e = byId.get(id);
    if (!e) rejectedReferences.push({ ref: r.ref, reason: "no such transcript entry" });
    else if (e.side !== r.side) rejectedReferences.push({ ref: r.ref, reason: `entry ${id} was spoken by Agent ${e.side}, not Agent ${r.side}` });
    else if (r.quote?.trim() && !norm(e.text).includes(norm(r.quote))) rejectedReferences.push({ ref: r.ref, reason: "quote does not appear in that entry" });
    else references.push({ ref: id, side: r.side, note: r.note, ...(r.quote?.trim() ? { quote: r.quote.trim() } : {}) });
  }
  if (!references.length) return { ok: false, reason: `judge cited no valid transcript reference (${rejectedReferences.map((x) => `${x.ref}: ${x.reason}`).join("; ") || "none given"})` };
  const known = (ref?: string) => (ref && byId.has(ref.trim().toUpperCase()) ? ref.trim().toUpperCase() : undefined);
  return {
    ok: true,
    verdict: {
      ...base,
      summary: v.summary,
      strengths: v.strengths,
      weaknesses: v.weaknesses,
      references,
      unsupportedAssumptions: v.unsupportedAssumptions.map((a) => ({ side: a.side, ...(known(a.ref) ? { ref: known(a.ref) } : {}), assumption: a.assumption })),
      decisiveExchange: { refs: v.decisiveExchange.refs.map(known).filter((x): x is string => Boolean(x)), description: v.decisiveExchange.description },
      validation: { rejectedReferences },
    },
  };
}
