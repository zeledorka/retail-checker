import type { AudienceInjection, AudienceReport, AudienceTheme, InjectionLimits, InjectionWindow, Side } from "./types";

/** One suggestion sent to the model. `supporters` = distinct players who sent this wording (sequential turns only). */
export type SelectedInjection = { id: string; text: string; supporters?: number; messages?: number };

/** Deterministic wording key: case, punctuation and spacing are ignored; words are NOT stemmed or reordered. */
export function themeKey(text: string): string {
  const lower = text.toLowerCase();
  return lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim() || lower;
}

/** Normalises untrusted audience text: strips control/invisible chars, collapses whitespace, caps length. */
export function sanitizeInjection(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ") // control + invisible format chars (zero-width, bidi overrides)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trimEnd() + "…" : cleaned;
}

export function timeOf(v: string | number): number {
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

const DEFAULT_BATCH_CHARS = 10_000;
const DEFAULT_BATCH_MESSAGES = 200;
const DEFAULT_PER_PLAYER = 2;

export type AudienceBatch = { included: SelectedInjection[]; report: AudienceReport };

/**
 * Bounded, deterministic batching of EVERY eligible submission for one speaking side (sequential turns).
 * Nothing is discarded because of a limit: what does not fit is returned as `queuedIds`.
 *
 * 1. Keep this side's submissions that are not consumed; blank-after-sanitising ones are `invalid`.
 * 2. Exact-text duplicates (case-insensitive) collapse onto the OLDEST copy; they are `duplicateIds` once that copy
 *    is included, and wait with it while it is queued. Duplicates never use batch capacity.
 * 3. Fairness: submissions are taken in rounds. Round 0 holds each player's oldest message, round 1 their second
 *    (up to `maxPerPlayer`; any further messages queue). Players without an id count as one player per message.
 * 4. Within a round the order alternates newest, oldest, next newest, next oldest, ..., so a fresh reaction to the
 *    latest argument and the longest-waiting message are served together.
 * 5. Fill in that order until the character budget (`batchChars`) or message cap (`batchMaxMessages`) is reached;
 *    a message that does not fit is skipped and may still be followed by shorter ones.
 * The included messages are returned oldest first. Output size depends only on the limits, never on audience size.
 * Does not read or mutate anything but its arguments; cost is O(n log n).
 */
export function selectAudienceBatch(
  all: AudienceInjection[] | undefined,
  side: Side,
  limits: InjectionLimits,
  consumed?: ReadonlySet<string>,
  now: number = Date.now(),
): AudienceBatch {
  const started = performance.now();
  const budget = limits.batchChars ?? DEFAULT_BATCH_CHARS;
  const maxMessages = limits.batchMaxMessages ?? DEFAULT_BATCH_MESSAGES;
  const perPlayer = Math.max(1, limits.maxPerPlayer ?? DEFAULT_PER_PLAYER);
  const list = all ?? [];

  type M = { id: string; text: string; norm: string; t: number; player?: string };
  const byOldest = (a: M, b: M) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let otherSide = 0;
  let alreadyConsumed = 0;
  const invalidIds: string[] = [];
  const mine: M[] = [];
  for (const i of list) {
    if (i.side !== side) {
      otherSide++;
      continue;
    }
    if (consumed?.has(i.id)) {
      alreadyConsumed++;
      continue;
    }
    const text = typeof i.text === "string" ? sanitizeInjection(i.text, limits.maxChars) : "";
    if (!text) {
      invalidIds.push(i.id);
      continue;
    }
    mine.push({ id: i.id, text, norm: themeKey(text), t: timeOf(i.submittedAt), player: i.playerId || undefined });
  }
  mine.sort(byOldest);

  // 2. identical wording forms a theme; the oldest copy represents it. A player counts once per theme.
  type Theme = { rep: M; members: M[]; players: Set<string>; anonymous: number };
  const themeMap = new Map<string, Theme>();
  for (const m of mine) {
    let th = themeMap.get(m.norm);
    if (!th) themeMap.set(m.norm, (th = { rep: m, members: [], players: new Set(), anonymous: 0 }));
    th.members.push(m);
    if (m.player) th.players.add(m.player);
    else th.anonymous++;
  }
  const themes = [...themeMap.values()]; // oldest representative first
  const unique = themes.map((t) => t.rep);
  const themeOf = new Map(themes.map((t) => [t.rep.id, t]));
  const duplicates = themes.flatMap((t) => t.members.slice(1).map((m) => ({ m, canon: t.rep })));
  const support = (m: M) => themeOf.get(m.id)!.players.size;

  // 3. rounds by player (unique is oldest-first, so round r holds each player's r-th oldest message)
  const seen = new Map<string, number>();
  const rounds: M[][] = Array.from({ length: perPlayer }, () => []);
  for (const m of unique) {
    const key = m.player ?? "\u0000" + m.id;
    const r = seen.get(key) ?? 0;
    seen.set(key, r + 1);
    if (r < perPlayer) rounds[r].push(m);
  }

  // 4 + 5. inside each round alternate: most-supported, newest, most-supported, oldest ... until the budget is used
  const includedSet = new Set<string>();
  let chars = 0;
  const consider = (m: M) => {
    if (includedSet.size >= maxMessages || chars + m.text.length > budget) return;
    includedSet.add(m.id);
    chars += m.text.length;
  };
  for (const round of rounds) {
    const lists = [[...round].sort((a, b) => support(b) - support(a) || byOldest(a, b)), [...round].reverse(), round];
    const ptr = [0, 0, 0];
    const done = new Set<string>();
    const next = (k: number) => {
      while (ptr[k] < lists[k].length && done.has(lists[k][ptr[k]].id)) ptr[k]++;
      return lists[k][ptr[k]];
    };
    while (done.size < round.length)
      for (const k of [0, 1, 0, 2]) {
        const m = next(k);
        if (m) {
          done.add(m.id);
          consider(m);
        }
      }
  }

  const included = unique.filter((m) => includedSet.has(m.id));
  const queued = unique.filter((m) => !includedSet.has(m.id));
  const dupProcessed = duplicates.filter((d) => includedSet.has(d.canon.id)).map((d) => d.m);
  const dupWaiting = duplicates.filter((d) => !includedSet.has(d.canon.id)).map((d) => d.m);
  const queuedAll = [...queued, ...dupWaiting].sort(byOldest);

  const includedIds = included.map((m) => m.id);
  const duplicateIds = dupProcessed.sort(byOldest).map((m) => m.id);
  const oldestQueued = queuedAll[0];
  const reportThemes: AudienceTheme[] = included
    .map((m) => ({ representativeId: m.id, text: m.text, supporters: support(m), messages: themeOf.get(m.id)!.members.length, anonymous: themeOf.get(m.id)!.anonymous, t: m.t }))
    .sort((a, b) => b.supporters - a.supporters || a.t - b.t || (a.representativeId < b.representativeId ? -1 : 1))
    .map(({ t: _t, ...th }) => th);
  return {
    included: included.map((m) => ({ id: m.id, text: m.text, supporters: support(m), messages: themeOf.get(m.id)!.members.length })),
    report: {
      includedIds,
      queuedIds: queuedAll.map((m) => m.id),
      duplicateIds,
      invalidIds,
      processedIds: [...includedIds, ...duplicateIds, ...invalidIds],
      themes: reportThemes,
      stats: {
        received: list.length,
        otherSide,
        alreadyConsumed,
        forSpeaker: mine.length + invalidIds.length,
        included: includedIds.length,
        queued: queuedAll.length,
        duplicates: duplicateIds.length,
        invalid: invalidIds.length,
        represented: includedIds.length + duplicateIds.length,
        themes: themes.length,
        themesIncluded: includedIds.length,
        chars,
        processingMs: Math.round((performance.now() - started) * 100) / 100,
        oldestQueuedAgeMs: oldestQueued && oldestQueued.t > 0 ? Math.max(0, now - oldestQueued.t) : undefined,
      },
    },
  };
}
