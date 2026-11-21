// Benchmark-only: compares the agent's validated grouping with the KNOWN category of every simulated player.
// It uses source IDs (player membership), never labels or keywords. Test code only.
import type { AudienceAnalysis } from "../src/types";

export type AuditInput = {
  analysis: AudienceAnalysis;
  /** wording id -> distinct players behind it (from the stored state). */
  playersOfWording: ReadonlyMap<string, readonly string[]>;
  /** player id -> known category (insurance, logbook, opposite, fabricated, injection, irrelevant, ...). */
  kindOfPlayer: ReadonlyMap<string, string>;
  /** Categories that should each form one idea, e.g. ["insurance", "logbook"]. */
  scored: string[];
  /** Categories that must never be merged into a scored idea, e.g. ["opposite", "fabricated", "injection", "irrelevant"]. */
  mustStaySeparate: string[];
  /** Categories whose claims oppose the supported side's idea and must not be merged with it. Default ["opposite"]. */
  contradictory?: string[];
  /** Players actually visible in this briefing (known category counts are limited to them). */
  visiblePlayers: ReadonlySet<string>;
};

export type CategoryAudit = {
  kind: string;
  expected: number;
  /** Largest agent group dominated by this category. */
  bestGroup?: { label: string; players: number; foreign: Record<string, number> };
  coveredByBestGroup: number;
  groupsTouched: number;
  notGrouped: number;
  /** PASS: one pure group holds >= 90%. SPLIT: pure but spread over several groups (under-merging, may be a legitimate strategic split). IMPURE: foreign players inside (over-merging). */
  verdict: "PASS" | "SPLIT" | "IMPURE" | "ABSENT";
};

export type AuditResult = {
  categories: CategoryAudit[];
  overMerged: { label: string; foreign: Record<string, number> }[];
  contradictionsMerged: string[];
  noiseMerged: string[];
  /** Groups made mostly of irrelevant / fabricated / adversarial / contradictory players that the agent rated relevant or says it used. */
  noiseAccepted: string[];
  /** Validation problems in the model output itself (invented ids, conflicts, quarantine, missing ids ...), independent of the test labels. */
  invalidAssignments: number;
  /** Known real-idea players who ended up in NO validated group, by where the agent put them. */
  missingMembership: { kind: string; notGrouped: number; unassigned: number; unsafe: number; quarantined: number; missing: number }[];
  /** Validated groups that mix two different real ideas (ordinary semantic disagreement or over-merging of tactics). */
  realIdeasMerged: string[];
  lines: string[];
};

export function auditGrouping(input: AuditInput): AuditResult {
  const { analysis, playersOfWording, kindOfPlayer, scored, mustStaySeparate, visiblePlayers } = input;
  const contradictory = input.contradictory ?? ["opposite"];
  const kindOf = (p: string) => kindOfPlayer.get(p) ?? "unknown";
  const groups = analysis.groups.map((g) => {
    const players = new Set(g.sourceWordingIds.flatMap((id) => playersOfWording.get(id) ?? []));
    const byKind: Record<string, number> = {};
    players.forEach((p) => (byKind[kindOf(p)] = (byKind[kindOf(p)] ?? 0) + 1));
    const dominant = Object.entries(byKind).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    return { label: g.label, players, byKind, dominant, used: g.usedInArgument, relevance: g.relevance };
  });
  const expectedOf = (kind: string) => [...visiblePlayers].filter((p) => kindOf(p) === kind);

  const categories: CategoryAudit[] = scored.map((kind) => {
    const expected = expectedOf(kind);
    if (!expected.length) return { kind, expected: 0, coveredByBestGroup: 0, groupsTouched: 0, notGrouped: 0, verdict: "ABSENT" };
    const touching = groups.filter((g) => expected.some((p) => g.players.has(p)));
    const own = groups.filter((g) => g.dominant === kind).sort((a, b) => (b.byKind[kind] ?? 0) - (a.byKind[kind] ?? 0));
    const best = own[0];
    const covered = best ? best.byKind[kind] ?? 0 : 0;
    const foreign = best ? Object.fromEntries(Object.entries(best.byKind).filter(([k]) => k !== kind)) : {};
    const impure = Object.values(foreign).reduce((a, b) => a + b, 0) > 0.1 * (best?.players.size ?? 1);
    const grouped = new Set(groups.flatMap((g) => [...g.players]));
    const verdict: CategoryAudit["verdict"] = !best ? "SPLIT" : impure ? "IMPURE" : covered >= 0.9 * expected.length ? "PASS" : "SPLIT";
    return {
      kind,
      expected: expected.length,
      bestGroup: best ? { label: best.label, players: best.players.size, foreign } : undefined,
      coveredByBestGroup: covered,
      groupsTouched: touching.length,
      notGrouped: expected.filter((p) => !grouped.has(p)).length,
      verdict,
    };
  });

  const overMerged = groups
    .map((g) => ({ label: g.label, foreign: Object.fromEntries(Object.entries(g.byKind).filter(([k]) => k !== g.dominant)) }))
    .filter((g) => Object.keys(g.foreign).length > 0);
  const contradictionsMerged = groups.filter((g) => contradictory.some((c) => (g.byKind[c] ?? 0) > 0) && scored.some((k) => (g.byKind[k] ?? 0) > 0)).map((g) => g.label);
  const noiseAccepted = groups
    .filter((g) => [...mustStaySeparate, ...contradictory].includes(g.dominant) && (g.used || g.relevance === "high" || g.relevance === "medium"))
    .map((g) => `${g.label} (${g.dominant} x${g.byKind[g.dominant]}, relevance ${g.relevance}, used ${g.used ? "yes" : "no"})`);
  const noiseMerged = groups.filter((g) => scored.includes(g.dominant) && mustStaySeparate.some((k) => (g.byKind[k] ?? 0) > 0)).map((g) => `${g.label} (${mustStaySeparate.filter((k) => (g.byKind[k] ?? 0) > 0).map((k) => `${k} x${g.byKind[k]}`).join(", ")})`);
  const oppositeVisible = contradictory.some((c) => expectedOf(c).length > 0);

  const lines: string[] = [];
  lines.push(`  Expected (known categories, distinct players visible): ${scored.map((k) => `${k} ${expectedOf(k).length}`).join(" | ")}${mustStaySeparate.length ? ` | should stay out of those ideas: ${mustStaySeparate.map((k) => `${k} ${expectedOf(k).length}`).join(", ")}` : ""}`);
  lines.push(`  Agent grouping: ${groups.length ? groups.map((g) => `"${g.label}" ${g.players.size} [${Object.entries(g.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}]`).join(" | ") : "none"}`);
  lines.push("  Grouping audit (membership by player ids, not labels):");
  for (const c of categories) {
    if (c.verdict === "ABSENT") continue;
    lines.push(`    ${c.kind} membership: ${c.verdict} — best group ${c.bestGroup ? `"${c.bestGroup.label}" holds ${c.coveredByBestGroup}/${c.expected}` : "none dominated by this category"}; spread over ${c.groupsTouched} group(s); not in any group ${c.notGrouped}${c.bestGroup && Object.keys(c.bestGroup.foreign).length ? `; foreign inside: ${Object.entries(c.bestGroup.foreign).map(([k, n]) => `${k} ${n}`).join(", ")} (OVER-MERGING)` : ""}${c.verdict === "SPLIT" ? " (UNDER-MERGING or a legitimate strategic split; read the labels)" : ""}`);
  }
  if (oppositeVisible) lines.push(`    Contradictory claims separated: ${contradictionsMerged.length ? `FAIL — merged into ${contradictionsMerged.map((l) => `"${l}"`).join(", ")}` : "PASS"}`);
  lines.push(`    Irrelevant / fabricated / adversarial kept out of real ideas: ${noiseMerged.length ? `FAIL — ${noiseMerged.join("; ")}` : "PASS"}`);
  lines.push(`    Irrelevant / fabricated / adversarial / contradictory ideas ACCEPTED as relevant or used: ${noiseAccepted.length ? `FLAG — ${noiseAccepted.join("; ")}` : "none"}`);
  const other = analysis.unassigned.length + analysis.unmentionedWordingIds.length;
  lines.push(`    Unassigned by the agent: ${analysis.unassigned.length} wording(s)${analysis.unassigned.length ? ` [${analysis.unassigned.map((u) => `${u.wordingId}:${u.reason}`).join(", ")}]` : ""} | not mentioned at all: ${analysis.unmentionedWordingIds.length} | other: ${other}`);
  // Distinguish the failure types the benchmark is meant to show (labels come from the test data, never from the model).
  const invalidAssignments = analysis.rejected.filter((r) => r.kind !== "claimed_count").length + analysis.quarantined.length;
  const wordingOfPlayer = new Map<string, string>();
  for (const [wid, players] of playersOfWording) for (const p of players) wordingOfPlayer.set(p, wid);
  const grouped = new Set(groups.flatMap((g) => [...g.players]));
  const missingMembership = scored
    .map((kind) => {
      const lost = expectedOf(kind).filter((p) => !grouped.has(p));
      const where = { unassigned: 0, unsafe: 0, quarantined: 0, missing: 0 };
      for (const p of lost) {
        const o = analysis.outcomes[wordingOfPlayer.get(p) ?? ""] ?? "missing";
        if (o === "unassigned" || o === "unsafe" || o === "quarantined" || o === "missing") where[o]++;
      }
      return { kind, notGrouped: lost.length, ...where };
    })
    .filter((m) => m.notGrouped > 0);
  const realIdeasMerged = groups
    .filter((g) => scored.filter((k) => (g.byKind[k] ?? 0) > 0).length > 1)
    .map((g) => `${g.label} (${scored.filter((k) => (g.byKind[k] ?? 0) > 0).map((k) => `${k} x${g.byKind[k]}`).join(" + ")})`);
  lines.push(`    Invalid assignments in the model output (invented ids, conflicts, quarantine, missing ids ...): ${invalidAssignments}`);
  lines.push(`    Missing membership (real-idea players in no validated group): ${missingMembership.length ? missingMembership.map((m) => `${m.kind} ${m.notGrouped} [unassigned ${m.unassigned}, unsafe ${m.unsafe}, quarantined ${m.quarantined}, not mentioned ${m.missing}]`).join("; ") : "none"}`);
  lines.push(`    Different real ideas merged into one group (semantic disagreement or over-merging of tactics): ${realIdeasMerged.length ? realIdeasMerged.join("; ") : "none"}`);
  lines.push(`    Strategic splits (one known idea spread over several groups; may be legitimate): ${categories.filter((c) => c.verdict === "SPLIT").map((c) => `${c.kind} over ${c.groupsTouched} groups`).join("; ") || "none"}`);
  return { categories, overMerged, contradictionsMerged, noiseMerged, noiseAccepted, invalidAssignments, missingMembership, realIdeasMerged, lines };
}
