import { hashSeed, mulberry32 } from "./personality";
import type { CheckerReport, FinalSelectionOptions, GeneratedOpinion, OpinionPair, OpinionSelectionDiagnostics, OpinionSelectionResult, PairRejection } from "./opinion-types";

/**
 * Deterministic final selection after the independent check. Pure: no model call, no clock, no global randomness.
 * The checker's assessments (made without knowing the sides) are mapped back to the six opinions; the nine A-B pairs are evaluated:
 *   rejected: an opinion the checker found contradicted or implausible (whatever its score) or scored below minDefensibility (default 30);
 *   a "speculative" opinion (plausible but resting on unverified assumptions) is eligible: missing proof is not contradiction; two opinions in one equivalence group (same
 *   explanation, different wording); a pair the checker says is not a meaningful disagreement or differs by less than minDifference;
 *   a pair whose checker scores differ by more than maxBalanceGap (one side overwhelmingly weak).
 *   score = mean checker defensibility + 0.25 x difference + modest rank bonus of each opinion's own agent - 0.3 x score gap
 *           - 8 for each opinion flagged with the legacy "unsupported" flag (not for "speculative").
 * Pairs within tieMargin of the best are tied and drawn with the seeded generator. Neither the agent label nor any list order is an
 * input to the score or to the tie order (ties are ordered by content hashes), so swapping labels mirrors the result.
 */
export const DEFAULT_SELECTION: Required<Omit<FinalSelectionOptions, "seed">> = { minDefensibility: 30, minDifference: 40, maxBalanceGap: 30, rankBonus: [6, 3, 0], tieMargin: 2 };
const UNSUPPORTED_PENALTY = 8;

export function selectFinalPair(input: { opinionsA: GeneratedOpinion[]; opinionsB: GeneratedOpinion[]; checkerOrder: { opinionId: string; anonId: string }[]; report: CheckerReport }, options: FinalSelectionOptions): OpinionSelectionResult {
  const opt = { ...DEFAULT_SELECTION, ...options };
  const anon = new Map(input.checkerOrder.map((x) => [x.opinionId, x.anonId]));
  const assess = new Map(input.report.assessments.map((a) => [a.id, a]));
  const groupOf = new Map<string, number>();
  input.report.equivalenceGroups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const pairs = new Map(input.report.pairs.map((p) => [[p.a, p.b].sort().join("|"), p]));
  const verdict = (o: GeneratedOpinion) => {
    const a = assess.get(anon.get(o.id) ?? "");
    if (!a) return { usable: false, reason: "no checker assessment" };
    if (a.flag === "contradicted" || a.flag === "implausible") return { usable: false, reason: `flagged ${a.flag}` };
    if (a.defensibility < opt.minDefensibility) return { usable: false, reason: `defensibility ${a.defensibility} < ${opt.minDefensibility}` };
    return { usable: true, reason: undefined };
  };
  const usable = (o: GeneratedOpinion) => verdict(o).usable;
  const pairStatus: OpinionSelectionDiagnostics["pairStatus"] = [];
  const reject = (x: GeneratedOpinion, y: GeneratedOpinion, why: PairRejection) => {
    rejected[why]++;
    pairStatus.push({ a: x.id, b: y.id, status: why });
  };
  const rejected: Record<PairRejection, number> = { contradicted_or_weak: 0, same_explanation: 0, cosmetic_difference: 0, unbalanced: 0 };
  const valid: (OpinionPair & { x: GeneratedOpinion; y: GeneratedOpinion })[] = [];
  for (const x of input.opinionsA)
    for (const y of input.opinionsB) {
      const ax = anon.get(x.id);
      const ay = anon.get(y.id);
      const sx = assess.get(ax ?? "");
      const sy = assess.get(ay ?? "");
      if (!ax || !ay || !sx || !sy || !usable(x) || !usable(y)) {
        reject(x, y, "contradicted_or_weak");
        continue;
      }
      const gx = groupOf.get(ax);
      if (gx !== undefined && gx === groupOf.get(ay)) {
        reject(x, y, "same_explanation");
        continue;
      }
      const pj = pairs.get([ax, ay].sort().join("|"));
      if (!pj || !pj.meaningful || pj.difference < opt.minDifference) {
        reject(x, y, "cosmetic_difference");
        continue;
      }
      const gap = Math.abs(sx.defensibility - sy.defensibility);
      if (gap > opt.maxBalanceGap) {
        reject(x, y, "unbalanced");
        continue;
      }
      const score =
        (sx.defensibility + sy.defensibility) / 2 + 0.25 * pj.difference + (opt.rankBonus[x.rank - 1] ?? 0) + (opt.rankBonus[y.rank - 1] ?? 0) - 0.3 * gap - (sx.flag === "unsupported" ? UNSUPPORTED_PENALTY : 0) - (sy.flag === "unsupported" ? UNSUPPORTED_PENALTY : 0);
      pairStatus.push({ a: x.id, b: y.id, status: "valid" });
      valid.push({ a: x.id, b: y.id, score: Math.round(score * 100) / 100, defensibilityA: sx.defensibility, defensibilityB: sy.defensibility, difference: pj.difference, rankA: x.rank, rankB: y.rank, x, y });
    }
  valid.sort((p, q) => q.score - p.score);
  const best = valid[0]?.score;
  const tied = best === undefined ? [] : valid.filter((p) => p.score >= best - opt.tieMargin);
  const strip = ({ x: _x, y: _y, ...p }: (typeof valid)[number]): OpinionPair => p;
  const diagnostics: OpinionSelectionDiagnostics = {
    pairsConsidered: input.opinionsA.length * input.opinionsB.length,
    rejected,
    usableA: input.opinionsA.filter(usable).length,
    usableB: input.opinionsB.filter(usable).length,
    pairsValid: valid.length,
    ...(best !== undefined ? { bestScore: best } : {}),
    tiedPairs: tied.length,
    topPairs: valid.slice(0, 5).map(strip),
    opinions: [...input.opinionsA, ...input.opinionsB].map((o) => {
      const a = assess.get(anon.get(o.id) ?? "");
      const v = verdict(o);
      return { id: o.id, anonId: anon.get(o.id), defensibility: a?.defensibility, flag: a?.flag, usable: v.usable, ...(v.reason ? { reason: v.reason } : {}) };
    }),
    pairStatus,
    options: { ...opt, seed: options.seed },
  };
  if (!tied.length) return { ok: false, reason: "no_credible_opposing_pair", message: `no meaningful, defensible, balanced pair among ${diagnostics.pairsConsidered} combinations (rejected: ${JSON.stringify(rejected)})`, diagnostics };
  // Tie order uses content only (never labels, ids or list order), then one seeded draw.
  const content = (p: (typeof tied)[number]) => `${hashSeed([p.x.explanation, p.y.explanation].sort().join("\u0001"))}:${hashSeed(p.x.explanation)}`;
  tied.sort((p, q) => (content(p) < content(q) ? -1 : content(p) > content(q) ? 1 : 0));
  const chosen = tied[Math.floor(mulberry32(hashSeed("final-selection", options.seed))() * tied.length)];
  return { ok: true, a: chosen.x, b: chosen.y, chosen: strip(chosen), diagnostics };
}
