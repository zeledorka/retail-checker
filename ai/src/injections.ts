import type { AudienceInjection, InjectionLimits, InjectionWindow, Side } from "./types";

export type SelectedInjection = { id: string; text: string };

/** Normalises untrusted audience text: strips control/invisible chars, collapses whitespace, caps length. */
export function sanitizeInjection(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ") // control + invisible format chars (zero-width, bidi overrides)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trimEnd() + "…" : cleaned;
}

function timeOf(v: string | number): number {
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0; // unparseable timestamps count as oldest, never as freshest
}

/**
 * Deterministic, bounded selection that balances recency and fairness. With limits.maxPerAgent = N:
 *   1. up to N - floor(N/3) RECENT submissions, newest first (N = 3 -> 2 recent);
 *   2. then the remaining slots (floor(N/3), i.e. 1 when N = 3) go to the OLDEST eligible submissions still waiting.
 *      If fewer than the recent slots qualified, the leftover slots are filled the same way.
 * Throughout: one submission per player per selection (a player's newest wins), duplicate texts removed
 * (case-insensitive, newest wins), text capped at limits.maxChars, consumed IDs never reused.
 * Ties on time break by id. The result is returned oldest to newest. This does NOT rank relevance:
 * the debating agent decides whether to use or ignore each suggestion.
 *
 * - `window` set: only that window (fixed-stage APIs). `undefined`: any window (sequential turns).
 * - Does not mutate `all`. Output size depends only on the limits, never on how many submissions exist.
 */
export function selectInjections(
  all: AudienceInjection[] | undefined,
  side: Side,
  window: InjectionWindow | undefined,
  limits: InjectionLimits,
  consumed?: ReadonlySet<string>,
): SelectedInjection[] {
  const cap = limits.maxPerAgent;
  if (!all?.length || cap <= 0) return [];
  const newestFirst = all
    .filter(
      (i) =>
        i.side === side &&
        (window === undefined || i.window === window) &&
        typeof i.text === "string" &&
        !consumed?.has(i.id),
    )
    .sort((a, b) => timeOf(b.submittedAt) - timeOf(a.submittedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const recentSlots = cap - Math.floor(cap / 3);
  const picked: { id: string; text: string; t: number }[] = [];
  const seenId = new Set<string>();
  const seenText = new Set<string>();
  const seenPlayer = new Set<string>();
  const take = (inj: AudienceInjection) => {
    if (seenId.has(inj.id)) return;
    const text = sanitizeInjection(inj.text, limits.maxChars);
    const norm = text.toLowerCase();
    if (!text || seenText.has(norm)) return;
    if (inj.playerId && seenPlayer.has(inj.playerId)) return;
    seenId.add(inj.id);
    seenText.add(norm);
    if (inj.playerId) seenPlayer.add(inj.playerId);
    picked.push({ id: inj.id, text, t: timeOf(inj.submittedAt) });
  };

  for (const inj of newestFirst) {
    if (picked.length >= recentSlots) break;
    take(inj);
  }
  for (let k = newestFirst.length - 1; k >= 0 && picked.length < cap; k--) take(newestFirst[k]);

  return picked.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(({ id, text }) => ({ id, text }));
}
