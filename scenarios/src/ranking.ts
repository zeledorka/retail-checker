import type { GenerateTextFn, ModelConfig } from "../../ai/src/index";
import { describePersonality, hashSeed, mulberry32 } from "./personality";
import type { OpinionRanker, OpinionRequest, RankerResult, RawRankingItem } from "./types";

/**
 * Opinion ranking = ONE model request per agent, two in parallel per round, made BEFORE the debate. Each request contains the
 * shared case and candidates plus only that agent's own personality, so neither agent sees the other's ranking or traits.
 *
 * Implementation status:
 *  - `createLlmRanker` builds the live ranker on the AI module's existing provider function (`generateText`, exported from
 *    ai/src/index.ts, which never throws). It has only been run with mocks; a live run is an explicit, separate step.
 *  - The AI module does not export a ranking API of its own (its opinion prompts live in ai/scripts, which are benchmark
 *    scripts, not production exports), so this adapter does not touch the debate engine.
 */

/** The same model as the debate: Claude Sonnet 5.5 at low effort. Replace via createLlmRanker's second argument if needed. */
export const RANKER_MODEL: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5-5", maxOutputTokens: 1500, timeoutMs: 30_000, maxRetries: 0, effort: "low" };

export const RANKER_SYSTEM = [
  "You assess candidate interpretations of an ambiguous case for a debate game.",
  "Use ONLY the supplied scenario and evidence. Never invent facts, witnesses or findings, and do not assume any interpretation is true.",
  "You are given your own reasoning tendencies. They change HOW YOU WEIGH the evidence, and you must apply them honestly: a high evidence standard penalises readings that need unsupported claims, a low one accepts plausible readings readily; willingness to infer lets you accept indirect but coherent evidence, caution keeps you to what is directly observed; a preference for simple explanations favours readings that need fewer assumptions, tolerance for complexity accepts many-part readings; risk tolerance lets you favour a bolder reading when it can still be defended. They do not oblige you to pick a different reading from anyone else: if the evidence leads you to the same reading, say so. They never allow invented facts and never override the evidence.",
  "Rank at most THREE interpretations from most to least defensible FOR YOU, using only the supplied candidate ids, each at most once.",
  'For each give "defensibility" (0-100) and a short "explanation" (at most 30 words) that cites the evidence. Defensibility is how reasonably you could defend the interpretation in a debate using the available evidence. It is not a probability that the interpretation is true, and not a guess at its likelihood.',
  "Scale: 0-20 cannot reasonably be defended from the evidence; 21-39 very weak, largely speculative; 40-59 arguable but with significant evidentiary gaps; 60-79 credible, with meaningful supporting evidence; 80-100 strongly defensible, with substantial evidence.",
  "An ambiguous case can legitimately have several interpretations above 60. Do not inflate or deflate scores to look balanced or decisive: if the evidence supports only one credible interpretation, give the others low scores and say so.",
  'Reply with ONLY JSON, no markdown: {"ranking":[{"id":"<candidate id>","rank":1,"defensibility":0-100,"explanation":"..."}]}',
].join("\n");

export function buildRankingPrompt(req: OpinionRequest): string {
  return [
    `CASE: ${req.scenario.title}`,
    `SCENARIO:\n${req.scenario.description}`,
    `EVIDENCE:\n${req.scenario.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n")}`,
    `CANDIDATE INTERPRETATIONS:\n${req.candidates.map((c) => `- ${c.id} | ${c.label}: ${c.description}`).join("\n")}`,
    `YOUR REASONING TENDENCIES:\n${describePersonality(req.personality)}`,
    "Return your ranking JSON now.",
  ].join("\n\n");
}

/** Extracts {"ranking":[...]} from a model reply (code fences and surrounding prose tolerated). The selector validates the content. */
export function parseRankingReply(raw: string): { ok: true; rankings: RawRankingItem[] } | { ok: false; message: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, message: "no JSON object in the ranking reply" };
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { ranking?: unknown };
    if (!Array.isArray(obj.ranking)) return { ok: false, message: 'the reply has no "ranking" list' };
    return { ok: true, rankings: obj.ranking as RawRankingItem[] };
  } catch {
    return { ok: false, message: "the ranking reply is not valid JSON" };
  }
}

export function createLlmRanker(generate: GenerateTextFn, model: ModelConfig = RANKER_MODEL): OpinionRanker {
  return {
    async rank(request) {
      const out = await generate(model, { system: RANKER_SYSTEM, prompt: buildRankingPrompt(request) });
      if (!out.ok) return { ok: false, error: { code: out.error.kind === "config" ? "config" : "model_error", message: out.error.message, retryable: out.error.retryable } };
      const parsed = parseRankingReply(out.result.text);
      if (!parsed.ok) return { ok: false, error: { code: "invalid_output", message: parsed.message, retryable: true } };
      const { model: m, latencyMs, inputTokens, outputTokens } = out.result;
      return { ok: true, rankings: parsed.rankings, telemetry: { model: m, latencyMs, inputTokens, outputTokens } };
    },
  };
}

/** Test double: you decide what each side returns. */
export function createMockRanker(fn: (request: OpinionRequest) => RankerResult | RawRankingItem[]): OpinionRanker & { requests: OpinionRequest[] } {
  const requests: OpinionRequest[] = [];
  return {
    requests,
    async rank(request) {
      requests.push(request);
      const r = fn(request);
      return Array.isArray(r) ? { ok: true, rankings: r } : r;
    },
  };
}

/** Deterministic pseudo-opinions derived from the personality seed: different per side and per seed, no network. For demos and tests only. */
export function createSeededMockRanker(): OpinionRanker & { requests: OpinionRequest[] } {
  return createMockRanker((req) => {
    const rand = mulberry32(hashSeed("mock-ranking", req.personality.seed, req.side));
    const order = req.candidates.map((c) => ({ id: c.id, v: rand() })).sort((a, b) => b.v - a.v).slice(0, 3);
    const base = [86, 76, 64];
    return order.map((o, k) => ({ id: o.id, rank: k + 1, defensibility: Math.max(40, Math.min(98, Math.round(base[k] + (rand() - 0.5) * 14))), explanation: `Mock opinion for candidate ${o.id} (no model was called).` }));
  });
}
