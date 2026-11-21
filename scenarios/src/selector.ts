import { hashSeed, mulberry32 } from "./personality";
import type { Interpretation, PairScore, RankingItem, SelectionDiagnostics, SelectionOptions, SelectionResult } from "./types";

/** Pure and deterministic: the same rankings and seed always give the same result. No model call is made here or needed. */

/**
 * Minimum self-assessed defensibility for an opinion to be usable. Initially 60, lowered to 45 after the first live run:
 * Sonnet 5.5 rates every reading of an under-determined case conservatively (18 to 62 over 18 live scores, median about 45),
 * so 60 rejected every opinion in 2 of 3 runs. 45 still excludes the weakest readings. See validation/live-ranking-2026-11-21.txt.
 */
export const DEFAULT_MIN_STRENGTH = 45;
export const DEFAULT_RANK_BONUS = [10, 3, 0];
export const DEFAULT_TIE_MARGIN = 2;
export const MAX_RANKED = 3;

/** Validates one agent's ranking against the candidate ids: up to 3 items, ranks exactly 1..n, no duplicate or invented ids. */
export function validateRanking(raw: unknown, candidateIds: ReadonlySet<string>): { ok: true; items: RankingItem[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) return { ok: false, errors: ["ranking is not a list"] };
  if (raw.length < 1 || raw.length > MAX_RANKED) return { ok: false, errors: [`ranking must have 1 to ${MAX_RANKED} items, got ${raw.length}`] };
  const errors: string[] = [];
  const items: RankingItem[] = [];
  const seen = new Set<string>();
  for (const [i, r] of raw.entries()) {
    const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const where = `item ${i + 1}`;
    if (typeof o.id !== "string" || !candidateIds.has(o.id)) errors.push(`${where}: "${String(o.id)}" is not a candidate interpretation id`);
    else if (seen.has(o.id)) errors.push(`${where}: duplicate id "${o.id}"`);
    else seen.add(o.id);
    if (!Number.isInteger(o.rank) || (o.rank as number) < 1) errors.push(`${where}: rank must be a positive integer`);
    if (typeof o.defensibility !== "number" || !Number.isFinite(o.defensibility) || o.defensibility < 0 || o.defensibility > 100) errors.push(`${where}: defensibility must be a number from 0 to 100`);
    if (typeof o.explanation !== "string" || !o.explanation.trim() || o.explanation.length > 400) errors.push(`${where}: explanation must be 1-400 characters`);
    if (!errors.length) items.push({ id: o.id as string, rank: o.rank as number, defensibility: o.defensibility as number, explanation: (o.explanation as string).trim() });
  }
  if (errors.length) return { ok: false, errors };
  items.sort((a, b) => a.rank - b.rank);
  if (items.some((it, k) => it.rank !== k + 1)) return { ok: false, errors: [`ranks must be exactly 1..${items.length} with no gaps or repeats`] };
  return { ok: true, items };
}

/**
 * Chooses the two locked interpretations. Every A-B combination is evaluated:
 *  - same interpretation on both sides: removed;
 *  - an opinion below `minStrength`: removed (no weak third choice is ever promoted just to create disagreement);
 *  - score = defensibility(A) + defensibility(B) + rankBonus[rank(A)] + rankBonus[rank(B)];
 *  - pairs within `tieMargin` of the best score are tied; one is drawn with the seeded generator (variety, reproducible).
 * No credible opposing pair -> an explicit failure (the caller picks another prepared scenario).
 */
export function selectOpinions(input: { candidates: Interpretation[]; rankingA: unknown; rankingB: unknown }, options: SelectionOptions): SelectionResult {
  const minStrength = options.minStrength ?? DEFAULT_MIN_STRENGTH;
  const bonus = options.rankBonus ?? DEFAULT_RANK_BONUS;
  const tieMargin = options.tieMargin ?? DEFAULT_TIE_MARGIN;
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  if (byId.size !== input.candidates.length || byId.size < 2) return { ok: false, reason: "invalid_ranking", errors: ["candidates must be at least two interpretations with unique ids"] };
  const ids = new Set(byId.keys());
  const a = validateRanking(input.rankingA, ids);
  if (!a.ok) return { ok: false, reason: "invalid_ranking", side: "A", errors: a.errors };
  const b = validateRanking(input.rankingB, ids);
  if (!b.ok) return { ok: false, reason: "invalid_ranking", side: "B", errors: b.errors };

  const usableA = a.items.filter((x) => x.defensibility >= minStrength);
  const usableB = b.items.filter((x) => x.defensibility >= minStrength);
  let same = 0;
  let weak = 0;
  const pairs: PairScore[] = [];
  for (const x of a.items)
    for (const y of b.items) {
      if (x.id === y.id) same++;
      else if (x.defensibility < minStrength || y.defensibility < minStrength) weak++;
      else pairs.push({ a: x.id, b: y.id, score: x.defensibility + y.defensibility + (bonus[x.rank - 1] ?? 0) + (bonus[y.rank - 1] ?? 0), rankA: x.rank, rankB: y.rank, defensibilityA: x.defensibility, defensibilityB: y.defensibility });
    }
  pairs.sort((p, q) => q.score - p.score || p.rankA + p.rankB - (q.rankA + q.rankB) || (p.a + p.b < q.a + q.b ? -1 : 1));
  const best = pairs[0]?.score;
  const tied = best === undefined ? [] : pairs.filter((p) => p.score >= best - tieMargin);
  const diagnostics: SelectionDiagnostics = {
    minStrength,
    opinionsA: a.items.length,
    opinionsB: b.items.length,
    usableA: usableA.length,
    usableB: usableB.length,
    pairsConsidered: a.items.length * b.items.length,
    pairsSameInterpretation: same,
    pairsBelowStrength: weak,
    pairsValid: pairs.length,
    ...(best !== undefined ? { bestScore: best } : {}),
    tiedPairs: tied.length,
    topPairs: pairs.slice(0, 5),
  };
  if (!tied.length) return { ok: false, reason: "no_credible_opposing_pair", errors: [`no pair of different interpretations with both opinions at or above ${minStrength}/100`], diagnostics };
  const chosen = tied[Math.floor(mulberry32(hashSeed("selection", options.seed))() * tied.length)];
  return { ok: true, a: byId.get(chosen.a)!, b: byId.get(chosen.b)!, chosen, diagnostics };
}
