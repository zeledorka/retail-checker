// Mocked end-to-end round: what Developer 3's API routes do, with an in-memory Map standing in for Supabase and a fake model.
// Run: npm run example:mock   (no network, no API key, no cost). Every step is a separate "invocation": load JSON, call ONE
// function, save JSON with a compare-and-swap on `revision`, exactly as a Vercel function would.
import { createAiRound, parseRoundState, publicRoundView, serializeRound, startRound } from "../src/index";
import type { AiRoundState, AudienceSubmission, GenerateTextFn } from "../src/index";
import { JUDGE_SYSTEM } from "../src/prompts";

/** A fake provider: plain text for openings, structured grouping JSON for turns with an audience, a valid verdict for the judge. */
export const mockProvider = (calls: { role: string; model: string; prompt: string }[]): GenerateTextFn => async (cfg, req) => {
  const role = req.system === JUDGE_SYSTEM ? "judge" : req.system.includes("You are Agent A") ? "agentA" : "agentB";
  calls.push({ role, model: cfg.model, prompt: req.prompt });
  let out = "Opening: the evidence supports my reading, and my opponent's inference does not follow from it.";
  if (role === "judge")
    out = JSON.stringify({
      winner: "A", explanation: "A answered B's strongest point directly.", summary: "A rebutted B more directly.",
      scores: { A: { evidence: 7, logic: 7, rebuttal: 8, persuasion: 7 }, B: { evidence: 6, logic: 6, rebuttal: 6, persuasion: 6 } },
      strengths: { A: ["Direct rebuttal"], B: ["Clear case"] }, weaknesses: { A: ["Some assumption"], B: ["Less responsive"] },
      references: [{ ref: "E1", side: "A", note: "opening sets the frame" }], unsupportedAssumptions: [],
      decisiveExchange: { refs: ["E1", "E2"], description: "openings" },
    });
  else if (req.system.includes("Output format for this turn")) {
    const line = req.prompt.split("\n").find((l) => l.startsWith('{"themes"'))!;
    const ids = (JSON.parse(line) as { themes: { id: string }[] }).themes.map((t) => t.id);
    out = JSON.stringify({ argument: "The audience point matters: the claim does not follow from the facts, and the alarm fits my reading better.", audienceAnalysis: { groups: [{ label: "Main idea", wordingIds: ids.join(" "), relevance: "high", used: true }], unassigned: {} } });
  }
  return { ok: true, result: { text: out, provider: "anthropic", model: cfg.model, latencyMs: 5, inputTokens: 1000, outputTokens: 100 } };
};

/** The backend's database stand-in: ONE JSON document per round. Real code: a Supabase jsonb column with `revision` checked in the UPDATE. */
class FakeDb {
  private rows = new Map<string, string>();
  save(state: AiRoundState, expectedRevision: number) {
    const current = this.rows.get(state.roundId);
    const stored = current ? (JSON.parse(current) as AiRoundState).revision : 0;
    if (current && stored !== expectedRevision) throw new Error(`concurrent update: stored revision ${stored}, expected ${expectedRevision}`);
    this.rows.set(state.roundId, serializeRound(state));
  }
  load(roundId: string): AiRoundState {
    const r = parseRoundState(this.rows.get(roundId)); // a missing or corrupt row is an error, never silently a new round
    if (!r.ok) throw new Error(r.error.message);
    return r.state;
  }
}

export async function runMockRound() {
  const calls: { role: string; model: string; prompt: string }[] = [];
  const ai = createAiRound(undefined, { generate: mockProvider(calls) }); // undefined = production defaults: Sonnet 5.5 for A, B and the judge, low effort
  const db = new FakeDb();
  const log: string[] = [];

  // Developer 2's validated scenario + locked interpretations come in here; the AI never changes them.
  const started = startRound({
    roundId: "room-42:round-1",
    scenario: {
      title: "The Empty Display Case",
      description: "A museum alarm sounded at 2 a.m. and a minor painting's case was found open and empty.",
      evidence: ["The alarm sounded at 2 a.m.", "No sign of forced entry", "An insurance renewal was due that week"],
      interpretationA: "An opportunistic theft by someone with access to the case keys.",
      interpretationB: "The theft was staged to support a future insurance claim.",
    },
  });
  if (!started.ok) throw new Error(started.error.message);
  db.save(started.state, 0);

  // The backend collects submissions (one per player, enforced there) and passes the cumulative list on every call.
  const all: AudienceSubmission[] = [];
  const submit = (side: "A" | "B", n: number, wave: number) => {
    for (let k = 0; k < n; k++) all.push({ id: `${side}-${wave}-${k}`, side, text: `${side} supporters, wave ${wave}: idea ${k % 3}`, submittedAt: wave * 1000 + k, playerId: `player-${side}-${wave}-${k}` });
  };

  // invocation 1 and 2: openings (each loads and saves the state)
  for (const side of ["A", "B"] as const) {
    const s = db.load("room-42:round-1");
    const step = await ai.generateOpening(s, side, { timeoutMs: 20_000 });
    if (!step.ok) throw new Error(step.error.message);
    db.save(step.state, s.revision);
    log.push(`opening ${side}: ${step.argument.text}`);
  }
  // invocations 3..10: eight sequential turns; submissions arrive between turns
  for (let n = 1; n <= 8; n++) {
    if (n === 1) { submit("A", 4, 1); submit("B", 3, 1); }
    if (n === 3) { submit("A", 3, 2); submit("B", 4, 2); }
    if (n === 5) submit("A", 2, 3);
    const s = db.load("room-42:round-1");
    const step = await ai.nextTurn(s, { submissions: all, turn: s.transcript.length + 1, timeoutMs: 20_000 });
    if (!step.ok) throw new Error(step.error.message);
    db.save(step.state, s.revision);
    log.push(`turn ${step.argument.sequence} (Agent ${step.argument.side}): ${step.argument.text}`);
  }
  // invocation 11: the independent judge
  const s = db.load("room-42:round-1");
  const verdict = await ai.judge(s);
  if (!verdict.ok) throw new Error(verdict.error.message);
  db.save(verdict.state, s.revision);

  const finalState = db.load("room-42:round-1");
  return { log, calls, view: publicRoundView(finalState), state: finalState, verdict: verdict.verdict };
}

if (process.argv[1]?.endsWith("mock-round.ts")) {
  const r = await runMockRound();
  console.log(r.log.join("\n"));
  console.log(`\nmodel requests: ${r.calls.length} (2 openings + 8 turns + 1 judge)`);
  console.log(`winner: Agent ${r.verdict.winner} | frontend view: status=${r.view.status}, ${r.view.transcript.length} public arguments`);
}
