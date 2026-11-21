import type { GenerateTextFn, ModelConfig } from "../../ai/src/index";
import { similarity } from "./schema";
import { describePersonality, hashSeed, mulberry32 } from "./personality";
import type { GeneratedOpinion, GenerationRequest, GenerationResult, OpinionGenerator, RawOpinion, ScenarioInput } from "./opinion-types";

/**
 * Independent opinion generation: ONE request per agent, two in parallel, made before the debate. Each request holds the same
 * scenario and numbered evidence plus ONLY that agent's own personality. No candidate interpretations are supplied: each agent
 * writes its own three. Status: only run with mocks so far (see HANDOFF.md for the live benchmark plan).
 */
export const GENERATOR_MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5-5", maxOutputTokens: 2500, timeoutMs: 40_000, maxRetries: 0, effort: "low" };

export const OPINION_SYSTEM = [
  "You analyse an ambiguous case for a debate game. Use ONLY the scenario and the numbered evidence items; cite evidence by its id. Never invent facts, witnesses, findings or evidence ids, and do not present any invented event, actor or motive as established.",
  "DIVERSITY OF EXPLANATIONS. Write EXACTLY THREE distinct interpretations that explain the scenario through substantially different causal mechanisms: different plausible causes, actors, motivations, accidents, technical failures or misunderstandings, wherever the evidence supports them. Nobody has given you candidates: they are yours. Before choosing which three to return, explore alternative explanations, including innocent, accidental, technical and staged ones, not only the single most probable story. Do not return three variations of one underlying explanation, and do not simply take the three most probable variants of the same idea. Different actors performing essentially the same act are ONE explanation (for example \"an employee stole it\", \"a guard stole it\" and \"a staff member secretly took it\" are the same mechanism). Different mechanisms look like: someone deliberately removed it; someone moved it by accident during legitimate work; someone staged the disappearance. Each interpretation must be distinct enough that defending it against another would produce a substantive debate.",
  "EVIDENCE AND CREDIBILITY. Every interpretation needs supporting evidence ids and an honest statement of its weaknesses or counterevidence. An interpretation may be less likely than another and still be reasonably defensible. Missing information is a gap, not a contradiction. If you cannot find three genuinely defensible, distinct interpretations, do not manufacture unsupported ones: reply with an explicit insufficient-diversity result instead.",
  "PERSONALITY. You are given your own reasoning tendencies. They decide HOW YOU WEIGH the evidence and which interpretation you prefer (a high evidence standard penalises readings that need unsupported claims; willingness to infer accepts indirect but coherent evidence; a preference for simple explanations favours fewer assumptions; risk tolerance allows a bolder reading when it can still be defended). Let them shape your ranking and scores. They must not narrow the range of causal explanations you consider, never allow invented facts, never override the evidence, and you are not required to differ from anyone or to agree with anyone.",
  'For each interpretation return: "title" (at most 8 words), "explanation" (the central causal explanation in one or two sentences), "supportingEvidenceIds" (ids from the list that support it), "weaknesses" (the main counterevidence or gap), "rank" (1 = the one you find most defensible; use 1, 2 and 3 once each) and "selfDefensibility" (0-100).',
  "selfDefensibility is how reasonably you could defend the interpretation in a debate using the available evidence: the ability to make a coherent, evidence-grounded argument. It is argument strength, not the probability that it is true. Scale: 0-20 cannot reasonably be defended; 21-39 very weak, largely speculative; 40-59 arguable with significant evidentiary gaps; 60-79 credible with meaningful support; 80-100 strongly defensible with substantial evidence. Do not inflate or deflate scores, and do not raise a score to make the interpretations look balanced.",
  'Reply with ONLY JSON, no markdown: {"opinions":[{"title":"","explanation":"","supportingEvidenceIds":["e1"],"weaknesses":"","rank":1,"selfDefensibility":0}]}. If three genuinely distinct defensible interpretations cannot be found, reply with ONLY: {"insufficientDiversity":{"reason":"one or two sentences on why"}}',
].join("\n");

export function buildOpinionPrompt(req: GenerationRequest): string {
  return [
    `CASE: ${req.scenario.title}`,
    `SCENARIO:\n${req.scenario.description}`,
    `EVIDENCE (cite by id):\n${req.scenario.evidence.map((e) => `${e.id}: ${e.text}`).join("\n")}`,
    `YOUR REASONING TENDENCIES:\n${describePersonality(req.personality)}`,
    "Return your three interpretations as JSON now.",
  ].join("\n\n");
}

const str = (v: unknown, min: number, max: number) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;

/** Validates one agent's reply: exactly three opinions, ranks 1-3 once each, only real evidence ids, bounded text and scores. */
export function validateOpinions(raw: unknown, scenario: ScenarioInput): { ok: true; opinions: RawOpinion[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) return { ok: false, errors: ["opinions is not a list"] };
  if (raw.length !== 3) return { ok: false, errors: [`expected exactly 3 opinions, got ${raw.length}`] };
  const ids = new Set(scenario.evidence.map((e) => e.id));
  const errors: string[] = [];
  const out: RawOpinion[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const w = `opinion ${i + 1}`;
    if (!str(o.title, 3, 80)) errors.push(`${w}: title must be 3-80 characters`);
    if (!str(o.explanation, 30, 500)) errors.push(`${w}: explanation must be 30-500 characters`);
    if (!str(o.weaknesses, 5, 400)) errors.push(`${w}: weaknesses must be 5-400 characters`);
    const refs = o.supportingEvidenceIds;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 8 || refs.some((x) => typeof x !== "string")) errors.push(`${w}: supportingEvidenceIds must be 1-8 evidence ids`);
    else {
      const invented = (refs as string[]).filter((x) => !ids.has(x));
      if (invented.length) errors.push(`${w}: invented evidence id(s) ${invented.join(", ")}`);
      if (new Set(refs as string[]).size !== refs.length) errors.push(`${w}: duplicate evidence ids`);
    }
    if (!Number.isInteger(o.rank) || (o.rank as number) < 1 || (o.rank as number) > 3) errors.push(`${w}: rank must be 1, 2 or 3`);
    if (typeof o.selfDefensibility !== "number" || !Number.isFinite(o.selfDefensibility) || o.selfDefensibility < 0 || o.selfDefensibility > 100) errors.push(`${w}: selfDefensibility must be a number from 0 to 100`);
    if (!errors.length) out.push({ title: (o.title as string).trim(), explanation: (o.explanation as string).trim(), supportingEvidenceIds: [...(refs as string[])], weaknesses: (o.weaknesses as string).trim(), rank: o.rank as number, selfDefensibility: o.selfDefensibility as number });
  }
  if (errors.length) return { ok: false, errors };
  if (new Set(out.map((o) => o.rank)).size !== 3) return { ok: false, errors: ["ranks must be 1, 2 and 3 exactly once each"] };
  // Cheap local sanity guard against copy-paste, NOT a semantic test: paraphrases and same-act/different-actor variants are judged by the independent checker.
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (similarity(`${out[i].title} ${out[i].explanation}`, `${out[j].title} ${out[j].explanation}`) >= 0.75) return { ok: false, errors: ["two of the three explanations are near-identical text"] };
  return { ok: true, opinions: out };
}

/** Parses {"opinions":[...]} from a reply (fences and prose tolerated), validates it and assigns ids A1..A3 / B1..B3 in reply order. */
export function parseOpinionReply(raw: string, side: GenerationRequest["side"], scenario: ScenarioInput): { ok: true; opinions: GeneratedOpinion[] } | { ok: false; message: string; errors: string[]; insufficientDiversity?: string } {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e <= s) return { ok: false, message: "no JSON object in the reply", errors: [] };
  let data: { opinions?: unknown };
  try {
    data = JSON.parse(raw.slice(s, e + 1)) as { opinions?: unknown };
  } catch {
    return { ok: false, message: "the reply is not valid JSON", errors: [] };
  }
  const ins = (data as { insufficientDiversity?: { reason?: unknown } }).insufficientDiversity;
  if (ins !== undefined && data.opinions === undefined) {
    const reason = typeof ins?.reason === "string" && ins.reason.trim() ? ins.reason.trim().slice(0, 400) : "no reason given";
    return { ok: false, message: `insufficient diversity: ${reason}`, errors: [], insufficientDiversity: reason };
  }
  const v = validateOpinions(data.opinions, scenario);
  if (!v.ok) return { ok: false, message: `invalid opinions: ${v.errors[0]}`, errors: v.errors };
  return { ok: true, opinions: v.opinions.map((o, k) => ({ ...o, id: `${side}${k + 1}`, side })) };
}

export function createLlmOpinionGenerator(generate: GenerateTextFn, model: ModelConfig = GENERATOR_MODEL): OpinionGenerator {
  return {
    async generate(request): Promise<GenerationResult> {
      const out = await generate(model, { system: OPINION_SYSTEM, prompt: buildOpinionPrompt(request) });
      if (!out.ok) return { ok: false, error: { code: out.error.kind === "config" ? "config" : "model_error", message: out.error.message, retryable: out.error.retryable } };
      const parsed = parseOpinionReply(out.result.text, request.side, request.scenario);
      if (!parsed.ok && parsed.insufficientDiversity !== undefined) return { ok: false, error: { code: "insufficient_diversity", message: parsed.message, retryable: false, raw: out.result.text } };
      if (!parsed.ok) return { ok: false, error: { code: "invalid_output", message: parsed.message, retryable: true, details: parsed.errors, raw: out.result.text } };
      const { model: m, latencyMs, inputTokens, outputTokens } = out.result;
      return { ok: true, opinions: parsed.opinions, telemetry: { model: m, latencyMs, inputTokens, outputTokens } };
    },
  };
}

/** Test double: you decide what each side returns (raw opinions are validated and given ids exactly like a live reply). */
export function createMockGenerator(fn: (req: GenerationRequest) => RawOpinion[] | GenerationResult): OpinionGenerator & { requests: GenerationRequest[] } {
  const requests: GenerationRequest[] = [];
  return {
    requests,
    async generate(request) {
      requests.push(request);
      const r = fn(request);
      if (!Array.isArray(r)) return r;
      const v = validateOpinions(r, request.scenario);
      if (!v.ok) return { ok: false, error: { code: "invalid_output", message: `invalid opinions: ${v.errors[0]}`, retryable: true, details: v.errors } };
      return { ok: true, opinions: v.opinions.map((o, k) => ({ ...o, id: `${request.side}${k + 1}`, side: request.side })) };
    },
  };
}

/** Builds a valid raw opinion for tests and demos. */
export const rawOpinion = (title: string, explanation: string, rank: number, selfDefensibility: number, supportingEvidenceIds: string[] = ["e1", "e2"], weaknesses = "Rests on some assumed links in the evidence."): RawOpinion => ({ title, explanation, supportingEvidenceIds, weaknesses, rank, selfDefensibility });

/** Seeded demo generator: three different readings drawn from a bank of (title, explanation) pairs per scenario, no network. For demos and tests only. */
export function createSeededMockGenerator(bank: Record<string, { title: string; explanation: string }[]>): OpinionGenerator & { requests: GenerationRequest[] } {
  return createMockGenerator((req) => {
    const pool = bank[req.scenario.id];
    if (!pool || pool.length < 3) return { ok: false, error: { code: "config", message: `no mock bank for ${req.scenario.id}`, retryable: false } };
    const rand = mulberry32(hashSeed("mock-generation", req.personality.seed, req.side));
    const picks = pool.map((p) => ({ p, v: rand() })).sort((a, b) => b.v - a.v).slice(0, 3);
    return picks.map(({ p }, k) => rawOpinion(p.title, p.explanation, k + 1, [78, 66, 54][k] + Math.round(rand() * 6), [req.scenario.evidence[k % req.scenario.evidence.length].id, req.scenario.evidence[(k + 1) % req.scenario.evidence.length].id]));
  });
}
