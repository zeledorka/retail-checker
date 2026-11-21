import type { AudienceAccounting, AudienceAnalysis, AudienceGroup, AudienceThemeState, ThemeBriefing, WordingOutcome } from "./types";

/**
 * The debating agent answers with ONE JSON object in the same request as its argument:
 *   {"argument":"...","audienceAnalysis":{"groups":[{"label","wordingIds":"t1 t4","relevance","used"}],"unassigned":{"irrelevant":"t2 t9"}}}
 * (compact: ids only, never audience text; the older array forms are still accepted).
 * The model decides which wordings express the same idea. Everything numeric is computed here from the briefing and the
 * stored state; a count the model claims is never used.
 *
 * VALIDATION POLICY (deterministic; it guarantees consistent id accounting, NOT that every semantic judgement is right):
 *  - every briefed wording id gets exactly one outcome: assigned | unsafe | unassigned | quarantined | missing;
 *  - an id the model invented is rejected and counted nowhere;
 *  - an id in two groups, or in a group AND in unassigned, is QUARANTINED: it counts toward no group (no "first group wins",
 *    and an id marked fabricated/adversarial can never be support for an ordinary idea just because it also sits in one);
 *  - an id the model set aside as irrelevant / fabricated / adversarial is "unsafe"; "unclear" (or an unrecognised reason) is "unassigned";
 *  - a group the model rates relevance "none" is excluded: its wordings are "unsafe" and give no support;
 *  - an id the model did not mention is "missing" and gets a recorded issue;
 *  - a group's supporters are the DISTINCT PLAYERS (set union) behind its validated wordings only; support for a broader idea
 *    must never be a sum of group counts. The raw submission always stays in the stored state.
 */

export type TurnOutput = { argument: string; analysis?: unknown; problem?: string };

const stripFence = (s: string) => s.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();

/** Splits a reply into the public argument and the raw analysis. Never throws; a malformed analysis keeps the argument. */
export function parseTurnOutput(raw: string): TurnOutput {
  const text = stripFence(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (obj && typeof obj.argument === "string" && obj.argument.trim()) return { argument: obj.argument.trim(), analysis: obj.audienceAnalysis, problem: obj.audienceAnalysis === undefined ? "no audienceAnalysis in the reply" : undefined };
    } catch {
      /* fall through to salvage */
    }
  }
  if (!text.startsWith("{")) return { argument: text, problem: "reply was plain text, not JSON; the whole reply is used as the argument" };
  const m = /"argument"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (m) {
    try {
      const arg = (JSON.parse(`"${m[1]}"`) as string).trim();
      if (arg) return { argument: arg, problem: "malformed JSON (possibly truncated); the argument was salvaged, the analysis discarded" };
    } catch {
      /* unusable */
    }
  }
  return { argument: "", problem: "reply was unusable JSON with no readable argument" };
}

const RELEVANCE = ["high", "medium", "low", "none"] as const;
const UNSAFE_REASONS = ["adversarial", "fabricated", "irrelevant"]; // most severe first
const REASONS = [...UNSAFE_REASONS, "unclear"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Wording ids as a list ("t1 t4,t7" or ["t1","t4"]); anything else is not a list. */
const idList = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : undefined);

type RawGroup = { label: string; ids: string[]; relevance: (typeof RELEVANCE)[number]; used: boolean; claimed?: number };

/** Validates the agent's grouping against the briefing it was given and computes the distinct-player counts. */
export function validateAudienceAnalysis(raw: unknown, problem: string | undefined, briefing: ThemeBriefing, state: AudienceThemeState, parseMs: number): AudienceAnalysis {
  const byId = new Map(state.themes.map((t) => [t.id, t]));
  const items = new Map(briefing.themes.map((t) => [t.id, t]));
  const briefed = briefing.themes.map((t) => t.id);
  const playersOf = (id: string) => byId.get(id)?.players ?? [];
  const rejected: AudienceAnalysis["rejected"] = [];
  let unknownIds = 0;
  const outcomes: Record<string, WordingOutcome> = {};
  const claims = new Map<string, { groups: number[]; reasons: string[] }>();
  const claimOf = (id: string) => {
    let c = claims.get(id);
    if (!c) claims.set(id, (c = { groups: [], reasons: [] }));
    return c;
  };
  const rawGroups: RawGroup[] = [];
  const structural = isObj(raw) && Array.isArray(raw.groups);

  if (!structural) rejected.push({ kind: "malformed", detail: problem ?? "audienceAnalysis.groups is missing or not a list" });
  else {
    if (problem) rejected.push({ kind: "malformed", detail: problem });
    for (const [gi, g] of (raw.groups as unknown[]).entries()) {
      const listed = isObj(g) ? idList(g.wordingIds) : undefined;
      if (!isObj(g) || !listed) {
        rejected.push({ kind: "malformed", detail: `group ${gi + 1} has no wordingIds` });
        continue;
      }
      const label = typeof g.label === "string" && g.label.trim() ? g.label.trim().slice(0, 80) : `(unlabelled group ${gi + 1})`;
      let relevance = RELEVANCE.find((r) => r === g.relevance);
      if (!relevance) {
        rejected.push({ kind: "unrecognised", detail: `group "${label}" has an unrecognised relevance "${String(g.relevance)}"; treated as low, never promoted` });
        relevance = "low";
      }
      const ids: string[] = [];
      for (const id of listed) {
        if (typeof id !== "string" || !items.has(id)) {
          unknownIds++;
          rejected.push({ kind: "unknown_id", detail: `"${String(id)}" in group "${label}" is not in the briefing; ignored` });
        } else if (!ids.includes(id)) ids.push(id);
      }
      const idx = rawGroups.push({ label, ids, relevance, used: g.used === true, claimed: typeof g.supporters === "number" ? g.supporters : undefined }) - 1;
      ids.forEach((id) => claimOf(id).groups.push(idx));
    }
    // unassigned: compact {"reason":"t1 t2"} or the older list [{"wordingId","reason"}]
    const pairs: [unknown, string][] = [];
    if (Array.isArray(raw.unassigned)) for (const u of raw.unassigned) pairs.push([isObj(u) ? u.wordingId : undefined, isObj(u) && typeof u.reason === "string" ? u.reason : "unclear"]);
    else if (isObj(raw.unassigned)) for (const [reason, v] of Object.entries(raw.unassigned)) for (const id of idList(v) ?? []) pairs.push([id, reason]);
    for (const [id, reasonRaw] of pairs) {
      let reason = reasonRaw.toLowerCase().trim();
      if (!REASONS.includes(reason)) {
        rejected.push({ kind: "unrecognised", detail: `unassigned reason "${reasonRaw.slice(0, 30)}" is not recognised; treated as unclear` });
        reason = "unclear";
      }
      if (typeof id !== "string" || !items.has(id)) {
        unknownIds++;
        rejected.push({ kind: "unknown_id", detail: `unassigned "${String(id)}" is not in the briefing; ignored` });
      } else claimOf(id).reasons.push(reason);
    }
  }

  // ---- one outcome per briefed wording
  const memberOf = new Map<number, string[]>(); // group index -> wordings that survive as unambiguous members
  const quarantinedBy = new Map<number, string[]>();
  const unassignedOut: AudienceAnalysis["unassigned"] = [];
  const quarantinedOut: AudienceAnalysis["quarantined"] = [];
  const supportersOf = (id: string) => playersOf(id).length;
  for (const id of briefed) {
    const c = claims.get(id) ?? { groups: [], reasons: [] };
    const groupsOfId = [...new Set(c.groups)];
    const reasons = [...new Set(c.reasons)];
    if (!groupsOfId.length && !reasons.length) {
      outcomes[id] = "missing";
      rejected.push({ kind: "missing", detail: `${id} was not accounted for (no group, not unassigned)` });
    } else if (!groupsOfId.length) {
      const reason = UNSAFE_REASONS.find((r) => reasons.includes(r)) ?? "unclear";
      outcomes[id] = UNSAFE_REASONS.includes(reason) ? "unsafe" : "unassigned";
      unassignedOut.push({ wordingId: id, reason, supporters: supportersOf(id) });
    } else if (groupsOfId.length === 1 && !reasons.length) {
      memberOf.set(groupsOfId[0], [...(memberOf.get(groupsOfId[0]) ?? []), id]);
      outcomes[id] = "assigned"; // provisional: a group rated relevance "none" demotes it below
    } else {
      outcomes[id] = "quarantined";
      const issue = groupsOfId.length > 1 ? `in ${groupsOfId.length} groups (${groupsOfId.map((g) => `"${rawGroups[g].label}"`).join(", ")})` : `in group "${rawGroups[groupsOfId[0]].label}" and also unassigned as ${reasons.join("/")}`;
      rejected.push({ kind: groupsOfId.length > 1 ? "overlap" : "conflict", detail: `${id} ${issue}: quarantined, counted nowhere` });
      quarantinedOut.push({ wordingId: id, issue, supporters: supportersOf(id) });
      groupsOfId.forEach((g) => quarantinedBy.set(g, [...(quarantinedBy.get(g) ?? []), id]));
    }
  }

  // ---- validated groups (support = distinct players of their unambiguous wordings only)
  const groups: AudienceGroup[] = [];
  const excludedGroups: AudienceAnalysis["excludedGroups"] = [];
  const allPlayers = new Set(briefed.flatMap(playersOf));
  const playerGroups = new Map<string, Set<string>>();
  for (const [gi, g] of rawGroups.entries()) {
    const members = memberOf.get(gi) ?? [];
    if (!members.length) {
      if (g.ids.length) rejected.push({ kind: "malformed", detail: `group "${g.label}" has no unambiguous wording left; dropped` });
      continue;
    }
    const players = new Set(members.flatMap(playersOf));
    if (g.relevance === "none") {
      members.forEach((id) => (outcomes[id] = "unsafe"));
      excludedGroups.push({ label: g.label, sourceWordingIds: members, supporters: players.size });
      rejected.push({ kind: "irrelevant_group", detail: `group "${g.label}" is rated relevance none: its ${members.length} wording(s) give no support` });
      continue;
    }
    players.forEach((p) => playerGroups.set(p, (playerGroups.get(p) ?? new Set()).add(g.label)));
    const group: AudienceGroup = {
      label: g.label,
      sourceWordingIds: members,
      supporters: players.size,
      messages: members.reduce((n, id) => n + (byId.get(id)?.messages ?? 0), 0),
      share: allPlayers.size ? players.size / allPlayers.size : 0,
      relevance: g.relevance,
      usedInArgument: g.used,
      status: members.every((id) => !items.get(id)!.briefedBefore) ? "new" : members.some((id) => items.get(id)!.newSupporters > 0) ? "growing" : "existing",
      ...(quarantinedBy.get(gi)?.length ? { quarantinedWordingIds: quarantinedBy.get(gi) } : {}),
    };
    if (g.claimed !== undefined && g.claimed !== players.size) {
      group.claimedSupporters = g.claimed;
      rejected.push({ kind: "claimed_count", detail: `group "${g.label}": model claimed ${g.claimed} supporters, computed ${players.size}; the claim is ignored` });
    }
    groups.push(group);
  }
  const repeated = [...playerGroups].filter(([, labels]) => labels.size > 1);
  if (repeated.length) rejected.push({ kind: "repeated_player", detail: `${repeated.length} player id(s) back more than one group (e.g. ${repeated[0][0]}); each group counts them once, totals use the union` });

  // ---- accounting: distinct players per bucket (sets, never added across groups)
  const bucket = (o: WordingOutcome) => {
    const ids = briefed.filter((id) => outcomes[id] === o);
    return { wordings: ids.length, players: new Set(ids.flatMap(playersOf)).size };
  };
  const accounting: AudienceAccounting = {
    briefedWordings: briefed.length,
    briefedPlayers: allPlayers.size,
    validated: bucket("assigned"),
    unsafe: bucket("unsafe"),
    unassigned: bucket("unassigned"),
    quarantined: bucket("quarantined"),
    missing: bucket("missing"),
    unknownIds,
    balanced: false,
  };
  accounting.balanced = accounting.validated.wordings + accounting.unsafe.wordings + accounting.unassigned.wordings + accounting.quarantined.wordings + accounting.missing.wordings === briefed.length;
  const validatedPlayers = new Set(groups.flatMap((g) => g.sourceWordingIds.flatMap(playersOf)));
  return {
    valid: structural && groups.length > 0,
    clean: structural && rejected.length === 0 && accounting.missing.wordings === 0 && accounting.quarantined.wordings === 0,
    groups,
    excludedGroups,
    unassigned: unassignedOut,
    quarantined: quarantinedOut,
    unmentionedWordingIds: briefed.filter((id) => outcomes[id] === "missing"),
    rejected,
    outcomes,
    accounting,
    totals: { briefedWordings: briefed.length, briefedPlayers: allPlayers.size, groupedPlayers: validatedPlayers.size, groupedWordings: accounting.validated.wordings },
    parseMs,
  };
}
