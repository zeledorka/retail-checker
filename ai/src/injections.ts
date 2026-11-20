import type { AudienceInjection, InjectionLimits, InjectionWindow, Side } from "./types";

export type SelectedInjection = { id: string; text: string };

/** Normalises untrusted audience text: strips control chars, collapses whitespace, caps length. */
export function sanitizeInjection(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ") // control + invisible format chars (zero-width, bidi overrides)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trimEnd() + "…" : cleaned;
}

function timeOf(v: string | number): number {
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Deterministic selection: earliest submissions first (ties broken by id),
 * one per player, exact duplicates removed, capped at maxPerAgent.
 * Only submissions for this side and window are considered.
 */
export function selectInjections(
  all: AudienceInjection[] | undefined,
  side: Side,
  window: InjectionWindow,
  limits: InjectionLimits,
): SelectedInjection[] {
  if (!all?.length || limits.maxPerAgent <= 0) return [];
  const candidates = all
    .filter((i) => i.side === side && i.window === window && typeof i.text === "string")
    .sort((a, b) => timeOf(a.submittedAt) - timeOf(b.submittedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const seenText = new Set<string>();
  const seenPlayer = new Set<string>();
  const out: SelectedInjection[] = [];
  for (const inj of candidates) {
    const text = sanitizeInjection(inj.text, limits.maxChars);
    const norm = text.toLowerCase();
    if (!text || seenText.has(norm)) continue;
    if (inj.playerId && seenPlayer.has(inj.playerId)) continue;
    seenText.add(norm);
    if (inj.playerId) seenPlayer.add(inj.playerId);
    out.push({ id: inj.id, text });
    if (out.length >= limits.maxPerAgent) break;
  }
  return out;
}
