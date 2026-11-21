import { similarity } from "./schema";
import type { CheckerReport, GeneratedOpinion, OpinionSelectionDiagnostics, PartialMeta } from "./opinion-types";

/** Phrases that suggest "the evidence does not mention it" is being treated as "the evidence rules it out". */
const MISSING_AS_CONTRADICTION = /\b(no|not|without)\b[^.]{0,40}\b(evidence|mention|record|indication|support|sign|proof)\b|\babsen|\bmissing\b|\black(s|ing)?\b|\bunstated\b|\bnot (stated|mentioned|supported)\b/i;

export type RunAnalysis = { lines: string[]; signals: Record<string, number | string> };

/**
 * Full human-readable diagnostics for one run, usable on success and on failure: every opinion, the checker's verdict and reasoning for it,
 * equivalence groups, all pair judgements, and a few mechanical signals that separate the three possible failure origins
 * (generation: opinions are paraphrases; checker: scores/flags too low or flags misused; selection: usable opinions rejected by pair rules).
 */
export function analyseRun(p: PartialMeta, selection?: OpinionSelectionDiagnostics): RunAnalysis {
  const lines: string[] = [];
  const signals: RunAnalysis["signals"] = {};
  const all: GeneratedOpinion[] = [...(p.generated?.A ?? []), ...(p.generated?.B ?? [])];
  for (const side of ["A", "B"] as const) {
    lines.push(`Agent ${side} personality: ${JSON.stringify(p.personalities[side])}`);
    for (const o of p.generated?.[side] ?? []) lines.push(`  ${o.id} rank ${o.rank} self ${o.selfDefensibility} | ${o.title}\n     explanation: ${o.explanation}\n     cites: ${o.supportingEvidenceIds.join(",")}\n     weaknesses: ${o.weaknesses}`);
  }
  if (all.length) {
    const sims: { a: string; b: string; s: number }[] = [];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) sims.push({ a: all[i].id, b: all[j].id, s: similarity(`${all[i].title} ${all[i].explanation}`, `${all[j].title} ${all[j].explanation}`) });
    const close = sims.filter((x) => x.s >= 0.4);
    signals.wordOverlapPairsAtOrAbove0_4 = close.length;
    lines.push(`Distinctness (word overlap, 0-1): highest ${Math.max(...sims.map((x) => x.s)).toFixed(2)}; pairs >= 0.40: ${close.map((x) => `${x.a}/${x.b} ${x.s.toFixed(2)}`).join(", ") || "none"}`);
    const selfScores = all.map((o) => o.selfDefensibility).sort((a, b) => a - b);
    signals.selfScoreMedian = selfScores[Math.floor(selfScores.length / 2)];
  }
  const r: CheckerReport | undefined = p.checkerReport;
  if (r && p.checkerOrder) {
    const opinionOf = new Map(p.checkerOrder.map((x) => [x.anonId, x.opinionId]));
    const byId = new Map(all.map((o) => [o.id, o]));
    lines.push("Checker assessments (anon id -> opinion | score | flag | its reasoning | agent's own self-score):");
    for (const a of [...r.assessments].sort((x, y) => x.id.localeCompare(y.id))) {
      const o = byId.get(opinionOf.get(a.id) ?? "");
      lines.push(`  ${a.id} -> ${o?.id} "${o?.title}" | ${a.defensibility} | ${a.flag} | ${a.note} | self ${o?.selfDefensibility}`);
    }
    const scores = r.assessments.map((a) => a.defensibility).sort((x, y) => x - y);
    const min = selection?.options.minDefensibility ?? 30;
    signals.checkerScoreMedian = scores[Math.floor(scores.length / 2)];
    signals.checkerBelowThreshold = scores.filter((s) => s < min).length;
    signals.checkerContradicted = r.assessments.filter((a) => a.flag === "contradicted" || a.flag === "implausible").length;
    signals.checkerSpeculative = r.assessments.filter((a) => a.flag === "speculative").length;
    signals.checkerUnsupported = r.assessments.filter((a) => a.flag === "unsupported").length;
    const suspect = r.assessments.filter((a) => (a.flag === "contradicted" || a.flag === "implausible" || a.flag === "unsupported") && MISSING_AS_CONTRADICTION.test(a.note));
    signals.flagsWhoseReasonLooksLikeMissingEvidence = suspect.length;
    if (suspect.length) lines.push(`Possible missing-evidence-treated-as-contradiction (read the notes): ${suspect.map((a) => `${a.id}[${a.flag}]`).join(", ")}`);
    const lowButOk = r.assessments.filter((a) => a.flag === "ok" && a.defensibility < min).length;
    signals.flaggedOkButBelowThreshold = lowButOk;
    lines.push(`Equivalence groups: ${r.equivalenceGroups.length ? r.equivalenceGroups.map((g) => `{${g.map((id) => `${id}=${opinionOf.get(id)}`).join(", ")}}`).join(" ") : "none"}`);
    lines.push("All pair judgements (difference / meaningful):");
    for (const x of r.pairs) lines.push(`  ${x.a}(${opinionOf.get(x.a)}) vs ${x.b}(${opinionOf.get(x.b)}): ${x.difference} / ${x.meaningful}`);
    const meaningful = r.pairs.filter((x) => x.meaningful).length;
    signals.meaningfulPairsOf15 = meaningful;
    signals.distinctExplanationsA = distinctExplanations(p.generated?.A ?? [], p.checkerOrder, r);
    signals.distinctExplanationsB = distinctExplanations(p.generated?.B ?? [], p.checkerOrder, r);
  }
  if (selection) {
    lines.push("Selector view of each opinion:");
    for (const o of selection.opinions) lines.push(`  ${o.id} (${o.anonId}) score ${o.defensibility} flag ${o.flag} -> ${o.usable ? "usable" : `UNUSABLE: ${o.reason}`}`);
    lines.push(`A-B pair outcomes: ${selection.pairStatus.map((x) => `${x.a}/${x.b}=${x.status}`).join(" ")}`);
    lines.push(`Rejections: ${JSON.stringify(selection.rejected)} | usableA ${selection.usableA}, usableB ${selection.usableB}, valid pairs ${selection.pairsValid}, options ${JSON.stringify(selection.options)}`);
    // Origin heuristic, stated as evidence not as a verdict.
    const origin = selection.usableA + selection.usableB <= 2 ? (Number(signals.checkerContradicted ?? 0) > 0 ? "checker flags/low scores removed most opinions (check whether the flags reflect missing evidence)" : "checker scores below the threshold removed most opinions (calibration, or genuinely weak opinions)") : selection.rejected.same_explanation + selection.rejected.cosmetic_difference >= selection.pairsConsidered - selection.rejected.contradicted_or_weak ? "usable opinions were all the same explanation (generation convergence)" : "pair rules (balance/difference)";
    signals.likelyOrigin = origin;
    lines.push(`Likely origin (mechanical, verify against the notes above): ${origin}`);
  }
  return { lines, signals };
}

/** Number of distinct explanations in an agent's three opinions, merging those the checker placed in one equivalence group. */
export function distinctExplanations(opinions: GeneratedOpinion[], order: { opinionId: string; anonId: string }[], report: CheckerReport): number {
  const anon = new Map(order.map((x) => [x.opinionId, x.anonId]));
  const groupOf = new Map<string, string>();
  report.equivalenceGroups.forEach((g, i) => g.forEach((id) => groupOf.set(id, `g${i}`)));
  return new Set(opinions.map((o) => groupOf.get(anon.get(o.id) ?? "") ?? o.id)).size;
}
