import type { GenerateTextFn, ModelConfig } from "../../ai/src/index";
import { hashSeed, mulberry32 } from "./personality";
import { similarity } from "./schema";
import type { CheckResult, CheckerAssessment, CheckerOpinion, CheckerReport, GeneratedOpinion, OpinionChecker, PairJudgement, ScenarioInput } from "./opinion-types";

/**
 * The independent semantic checker: ONE request that sees the scenario and all six opinions in a seeded shuffled order under
 * anonymous ids (o1..o6). It never sees which agent wrote an opinion, any personality, the agents' ranks or self-scores, bets,
 * audience data or debate history, and it does not decide who is right. Its assessments feed the deterministic selector.
 * Status: only run with mocks so far.
 */
export const CHECKER_MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5-5", maxOutputTokens: 3000, timeoutMs: 45_000, maxRetries: 0, effort: "low" };

export const CHECKER_SYSTEM = [
  "You are an independent reviewer of interpretations of an ambiguous case for a debate game. You do not know who wrote any interpretation and must not guess. Use ONLY the scenario and the numbered evidence. You do NOT decide which interpretation is true or which side should win. This is an entertaining game, not a trial: you are asked whether an interpretation is reasonably arguable, not whether it is proven or likely.",
  "Defensibility is the ability to construct a coherent, evidence-consistent argument for the interpretation. It is NOT the probability that the explanation is correct. Score by this scale: 0-19 implausible, contradictory or not meaningfully connected to the case; 20-29 extremely speculative with little basis for a coherent argument; 30-44 speculative but reasonably arguable; 45-69 a plausible interpretation with some supporting evidence; 70-100 strongly defensible. Use the same standard for every opinion. Do not inflate or deflate scores, and do not adjust them to make opinions look balanced or opposed.",
  'Flags. "ok": plausible, consistent with the evidence, may need ordinary inference. "speculative": plausible but requires unverified assumptions, is not conclusively supported, yet could reasonably explain the observations (it stays eligible; score it 30 or more if a coherent argument can be built). "contradicted": the evidence shows it could not have happened. "implausible": it needs an implausible causal mechanism or depends on fabricated facts presented as established evidence. Only "contradicted" and "implausible" make an opinion ineligible.',
  'Absence of supporting evidence is NOT contradiction. Distinguish "there is no evidence proving this happened" (speculative at most) from "the evidence shows this could not have happened" (contradicted). An unverified actor, motive or mechanism is not by itself a reason to flag or to score low. Missing information is a gap, not a contradiction; the absence of something that would only happen later does not contradict an earlier plan.',
  "You receive six opinions (o1..o6). Return:",
  '1. "assessments": one entry for EVERY opinion with "defensibility" (0-100, scale above), "flag" ("ok", "speculative", "contradicted" or "implausible") and a "note" of at most 15 words.',
  '2. "equivalenceGroups": lists of opinion ids that describe the SAME underlying explanation (same cause and mechanism) however differently worded; different actors performing essentially the same act are the same explanation. Only groups of two or more; an id appears in at most one group.',
  '3. "pairs": an entry for EVERY unordered pair of the six opinions (15 pairs): "difference" (0-100, how different their central causal explanations really are) and "meaningful" (true only if the two could form a substantive disagreement that a debate can turn on; false for differences of wording, emphasis, level of detail or terminology). Opinions in the same equivalence group have difference below 20 and meaningful false. Two different speculative explanations can be a meaningful pair.',
  'Reply with ONLY JSON, no markdown: {"assessments":[{"id":"o1","defensibility":0,"flag":"ok","note":""}],"equivalenceGroups":[["o1","o4"]],"pairs":[{"a":"o1","b":"o2","difference":0,"meaningful":false}]}',
].join("\n");

/** Assigns anonymous ids o1..on in a seeded shuffled order. The mapping is kept server-side and restored after the check. */
export function anonymise(opinions: GeneratedOpinion[], seed: number): { checkerOpinions: CheckerOpinion[]; order: { opinionId: string; anonId: string }[] } {
  const items = [...opinions];
  const rand = mulberry32(hashSeed("checker-order", seed));
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const order = items.map((o, k) => ({ opinionId: o.id, anonId: `o${k + 1}` }));
  // Only content leaves this function: no side, rank, self-score or original id.
  const checkerOpinions = items.map((o, k) => ({ id: `o${k + 1}`, title: o.title, explanation: o.explanation, supportingEvidenceIds: [...o.supportingEvidenceIds], weaknesses: o.weaknesses }));
  return { checkerOpinions, order };
}

export function buildCheckerPrompt(scenario: ScenarioInput, opinions: CheckerOpinion[]): string {
  return [
    `CASE: ${scenario.title}`,
    `SCENARIO:\n${scenario.description}`,
    `EVIDENCE:\n${scenario.evidence.map((e) => `${e.id}: ${e.text}`).join("\n")}`,
    `OPINIONS (anonymous, in random order):\n${opinions.map((o) => `${o.id} | ${o.title}\n  explanation: ${o.explanation}\n  cites: ${o.supportingEvidenceIds.join(", ")}\n  weaknesses: ${o.weaknesses}`).join("\n")}`,
    "Return the JSON now.",
  ].join("\n\n");
}

const FLAGS = ["ok", "speculative", "unsupported", "contradicted", "implausible"];

/** Validates a checker reply against the anonymous ids it was given: complete assessments, valid groups, all unordered pairs once. */
export function validateCheckerReport(raw: unknown, anonIds: string[]): { ok: true; report: CheckerReport } | { ok: false; errors: string[] } {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const ids = new Set(anonIds);
  const errors: string[] = [];
  const assessments: CheckerAssessment[] = [];
  if (!Array.isArray(o.assessments)) errors.push("assessments is not a list");
  else {
    const seen = new Set<string>();
    for (const a of o.assessments as Record<string, unknown>[]) {
      const id = a?.id;
      if (typeof id !== "string" || !ids.has(id)) errors.push(`assessment for unknown id "${String(id)}"`);
      else if (seen.has(id)) errors.push(`duplicate assessment for ${id}`);
      else {
        seen.add(id);
        if (typeof a.defensibility !== "number" || !Number.isFinite(a.defensibility) || a.defensibility < 0 || a.defensibility > 100) errors.push(`${id}: defensibility must be 0-100`);
        else if (typeof a.flag !== "string" || !FLAGS.includes(a.flag)) errors.push(`${id}: flag must be ok, speculative, unsupported, contradicted or implausible`);
        else assessments.push({ id, defensibility: a.defensibility, flag: a.flag as CheckerAssessment["flag"], note: typeof a.note === "string" ? a.note.slice(0, 200) : "" });
      }
    }
    for (const id of anonIds) if (!seen.has(id)) errors.push(`no assessment for ${id}`);
  }
  const groups: string[][] = [];
  if (!Array.isArray(o.equivalenceGroups)) errors.push("equivalenceGroups is not a list");
  else {
    const inGroup = new Set<string>();
    for (const g of o.equivalenceGroups as unknown[]) {
      if (!Array.isArray(g) || g.length < 2 || g.some((x) => typeof x !== "string" || !ids.has(x)) || new Set(g).size !== g.length) errors.push("an equivalence group must list two or more distinct known ids");
      else if ((g as string[]).some((x) => inGroup.has(x))) errors.push("an id appears in more than one equivalence group");
      else {
        (g as string[]).forEach((x) => inGroup.add(x));
        groups.push([...(g as string[])]);
      }
    }
  }
  const pairs: PairJudgement[] = [];
  const expected = (anonIds.length * (anonIds.length - 1)) / 2;
  if (!Array.isArray(o.pairs)) errors.push("pairs is not a list");
  else {
    const seen = new Set<string>();
    for (const p of o.pairs as Record<string, unknown>[]) {
      const a = p?.a;
      const b = p?.b;
      if (typeof a !== "string" || typeof b !== "string" || !ids.has(a) || !ids.has(b) || a === b) errors.push(`pair (${String(a)}, ${String(b)}) is not two different known ids`);
      else if (typeof p.difference !== "number" || !Number.isFinite(p.difference) || p.difference < 0 || p.difference > 100 || typeof p.meaningful !== "boolean") errors.push(`pair ${a}/${b}: difference must be 0-100 and meaningful a boolean`);
      else {
        const key = [a, b].sort().join("|");
        if (seen.has(key)) errors.push(`pair ${a}/${b} listed twice`);
        else {
          seen.add(key);
          pairs.push({ a, b, difference: p.difference, meaningful: p.meaningful });
        }
      }
    }
    if (!errors.length && pairs.length !== expected) errors.push(`expected ${expected} pairs, got ${pairs.length}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, report: { assessments, equivalenceGroups: groups, pairs } };
}

export function parseCheckerReply(raw: string, anonIds: string[]): { ok: true; report: CheckerReport } | { ok: false; message: string; errors: string[] } {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e <= s) return { ok: false, message: "no JSON object in the checker reply", errors: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(s, e + 1));
  } catch {
    return { ok: false, message: "the checker reply is not valid JSON", errors: [] };
  }
  const v = validateCheckerReport(data, anonIds);
  return v.ok ? v : { ok: false, message: `invalid checker report: ${v.errors[0]}`, errors: v.errors };
}

export function createLlmChecker(generate: GenerateTextFn, model: ModelConfig = CHECKER_MODEL): OpinionChecker {
  return {
    async check(request): Promise<CheckResult> {
      const anonIds = request.opinions.map((x) => x.id);
      const out = await generate(model, { system: CHECKER_SYSTEM, prompt: buildCheckerPrompt(request.scenario, request.opinions) });
      if (!out.ok) return { ok: false, error: { code: out.error.kind === "config" ? "config" : "model_error", message: out.error.message, retryable: out.error.retryable } };
      const parsed = parseCheckerReply(out.result.text, anonIds);
      if (!parsed.ok) return { ok: false, error: { code: "invalid_output", message: parsed.message, retryable: true, details: parsed.errors, raw: out.result.text } };
      const { model: m, latencyMs, inputTokens, outputTokens } = out.result;
      return { ok: true, report: parsed.report, telemetry: { model: m, latencyMs, inputTokens, outputTokens } };
    },
  };
}

/** Test double: you decide the report (or an error) from the anonymised request. */
export function createMockChecker(fn: (req: { scenario: ScenarioInput; opinions: CheckerOpinion[] }) => CheckerReport | CheckResult): OpinionChecker & { requests: { scenario: ScenarioInput; opinions: CheckerOpinion[] }[] } {
  const requests: { scenario: ScenarioInput; opinions: CheckerOpinion[] }[] = [];
  return {
    requests,
    async check(request) {
      requests.push(request);
      const r = fn(request);
      return "assessments" in r ? { ok: true, report: r } : r;
    },
  };
}

/**
 * Content-based demo checker (no network): equivalence and difference from word overlap of the explanations, a fixed defensibility.
 * It keys on CONTENT only, so label swaps and shuffles cannot change its verdicts: useful to test the pipeline's own invariance.
 */
export function createHeuristicMockChecker(defensibility = 68): OpinionChecker & { requests: { scenario: ScenarioInput; opinions: CheckerOpinion[] }[] } {
  return createMockChecker(({ opinions }) => {
    const sim = (a: CheckerOpinion, b: CheckerOpinion) => similarity(`${a.title} ${a.explanation}`, `${b.title} ${b.explanation}`);
    const groups: string[][] = [];
    const used = new Set<string>();
    for (const a of opinions) {
      if (used.has(a.id)) continue;
      const g = opinions.filter((b) => b.id === a.id || (!used.has(b.id) && sim(a, b) >= 0.5));
      if (g.length >= 2) {
        g.forEach((x) => used.add(x.id));
        groups.push(g.map((x) => x.id));
      }
    }
    const pairs: PairJudgement[] = [];
    for (let i = 0; i < opinions.length; i++)
      for (let j = i + 1; j < opinions.length; j++) {
        const s = sim(opinions[i], opinions[j]);
        const same = groups.some((g) => g.includes(opinions[i].id) && g.includes(opinions[j].id));
        pairs.push({ a: opinions[i].id, b: opinions[j].id, difference: same ? 10 : Math.round(100 - s * 100), meaningful: !same && s < 0.4 });
      }
    return { assessments: opinions.map((o) => ({ id: o.id, defensibility, flag: "ok" as const, note: "heuristic demo assessment" })), equivalenceGroups: groups, pairs };
  });
}
