import type { EngineConfig, GenerateRequest, GenerateTextFn, ModelConfig, Scenario, TranscriptEntry } from "../src/types";

const model = (provider: ModelConfig["provider"], id: string): ModelConfig => ({
  provider,
  model: id,
  maxOutputTokens: 500,
  timeoutMs: 1000,
  maxRetries: 0,
});

export const config: EngineConfig = {
  agentA: model("anthropic", "mock-claude"),
  agentB: model("openrouter", "mock/deepseek"),
  judge: model("anthropic", "mock-judge"),
  argumentMaxWords: 80,
  injections: { maxPerAgent: 2, maxChars: 50 },
  judgeParseRetries: 1,
};

export const scenario: Scenario = {
  title: "The Missing Cake",
  description: "A cake vanished from the office kitchen at 3pm.",
  evidence: ["Crumbs on Dave's desk", "Dave was in a meeting 2-4pm"],
  interpretationA: "Dave ate the cake",
  interpretationB: "Someone framed Dave",
};

export const fullTranscript: TranscriptEntry[] = (["opening", "rebuttal", "closing"] as const).flatMap((stage) =>
  (["A", "B"] as const).map((side) => ({ stage, side, text: `${side} ${stage} text` })),
);

/** Records every call and answers with a canned reply chosen by `reply`. */
export function mockGenerate(reply: (cfg: ModelConfig, req: GenerateRequest) => string | Error = (c) => `arg from ${c.model}`) {
  const calls: { cfg: ModelConfig; req: GenerateRequest }[] = [];
  const fn: GenerateTextFn = async (cfg, req) => {
    calls.push({ cfg, req });
    const r = reply(cfg, req);
    if (r instanceof Error)
      return { ok: false, error: { kind: "timeout", message: r.message, provider: cfg.provider, model: cfg.model, retryable: true } };
    return { ok: true, result: { text: r, provider: cfg.provider, model: cfg.model, latencyMs: 5, inputTokens: 10, outputTokens: 20 } };
  };
  return { fn, calls };
}

/** A complete, valid judge reply (new contract). Cites E1 (Agent A's first entry in every fixture transcript). */
export const verdictJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    winner: "A",
    explanation: "A tied the crumbs to Dave and answered B's alibi point directly.",
    summary: "A was more specific and answered B.",
    scores: { A: { evidence: 8, logic: 7, rebuttal: 7, persuasion: 8 }, B: { evidence: 6, logic: 6, rebuttal: 5, persuasion: 6 } },
    strengths: { A: ["Used the crumbs evidence"], B: ["Raised a fair alibi point"] },
    weaknesses: { A: ["Assumed Dave was hungry"], B: ["Offered no evidence for a frame-up"] },
    references: [{ ref: "E1", side: "A", note: "opening ties the crumbs to Dave" }],
    unsupportedAssumptions: [{ side: "A", ref: "E1", assumption: "Dave was hungry" }],
    decisiveExchange: { refs: ["E1"], description: "A's crumbs point against B's alibi" },
    ...over,
  });
