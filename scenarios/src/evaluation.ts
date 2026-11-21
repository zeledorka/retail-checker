// Pure helpers for the live ranking evaluation (scripts/evaluate-live.ts). No model calls here.
import { hashSeed, mulberry32 } from "./personality";
import type { Personality } from "./types";

/** The planned evaluation: 6 runs = 12 paid ranking requests (A and B in parallel, one attempt per run, no retries or fallback). */
export const EVAL_PLAN: { caseId: string; seed: number }[] = [
  { caseId: "empty-display-case", seed: 1101 },
  { caseId: "empty-display-case", seed: 2202 },
  { caseId: "silent-call", seed: 3303 },
  { caseId: "missing-rows", seed: 4404 },
  { caseId: "open-gate", seed: 5505 },
  { caseId: "drawn-curtains", seed: 6606 },
];
export const EVAL_REQUESTS_PER_RUN = 2;
export const EVAL_REQUEST_CAP = EVAL_PLAN.length * EVAL_REQUESTS_PER_RUN;

/** Deterministic shuffle (seeded): used to vary the candidate listing order between runs, to expose position bias. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(hashSeed("listing-order", seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Kendall rank correlation over the ids both rankings contain (-1 opposite order .. 1 same order); undefined if fewer than two shared. */
export function kendallTau(a: string[], b: string[]): number | undefined {
  const shared = a.filter((x) => b.includes(x));
  if (shared.length < 2) return undefined;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i++)
    for (let j = i + 1; j < shared.length; j++) {
      const da = a.indexOf(shared[i]) - a.indexOf(shared[j]);
      const db = b.indexOf(shared[i]) - b.indexOf(shared[j]);
      if (da * db > 0) concordant++;
      else discordant++;
    }
  return (concordant - discordant) / (concordant + discordant);
}

const TRAITS = ["evidenceScepticism", "inferenceWillingness", "riskTolerance", "simplicityPreference"] as const;
/** Euclidean distance over the four evidence-weighing traits, scaled to 0..1 (the style traits do not weigh evidence). */
export function personalityDistance(a: Personality, b: Personality): number {
  const sq = TRAITS.reduce((s, t) => s + (a[t] - b[t]) ** 2, 0);
  return Math.sqrt(sq) / Math.sqrt(TRAITS.length * 0.9 ** 2);
}

/** Zero-based position, in the listing shown to the agent, of its first-ranked interpretation. */
export function firstChoicePosition(listing: readonly string[], ranking: readonly { id: string }[]): number {
  return ranking.length ? listing.indexOf(ranking[0].id) : -1;
}

/** true when the ranking is simply the listing order (the first k candidates in order): a sign of position bias. */
export function copiesListingOrder(listing: readonly string[], ranking: readonly { id: string }[]): boolean {
  return ranking.length > 0 && ranking.every((r, k) => listing[k] === r.id);
}
