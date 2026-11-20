// MANUAL LIVE EXPERIMENT (billed): do different personas lead two agents to different independent opinions?
//   npm run test:personas -- --limit=2          first two scenarios (4 calls)
//   npm run test:personas                       all six scenarios (12 calls)
//   npm run test:personas -- --scenario-set=vague   minimal-information scenarios (default: original)
//   npm run test:personas -- --swap-personas    reverse which agent gets which persona
//   npm run test:personas -- --save             also write full results to ai/test-output/ (git-ignored)
// Requires OPENROUTER_API_KEY in the environment or ai/.env. No judge, debate, injections, retries or forced disagreement.
// All scenarios and personas live only in this script; none are production game content.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { generateText } from "../src/index";
import type { GenerateOutcome, ModelConfig } from "../src/types";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file: rely on the shell environment */
}

// ---------- Experiment data (edit freely) ----------

type Scenario = { name: string; description: string };
type Persona = { id: string; name: string; approach: string };

const ORIGINAL_SCENARIOS: Scenario[] = [
  {
    name: "The Bloody Cloth",
    description:
      "A red-stained cloth is discovered in a house the morning after a Halloween party. A neighbour reported hearing an argument the previous evening. Nobody has been reported missing.",
  },
  {
    name: "The Night Noise",
    description:
      "A security guard hears repeated knocking from the third floor of an empty office building at 2 a.m. The floor was locked at 7 p.m. and the alarm log shows no entries overnight. The heating system on that floor was serviced that afternoon.",
  },
  {
    name: "The Damaged Parcel",
    description:
      "A woman receives a parcel with one corner crushed and its tape resealed with a different type of tape. The ceramic vase inside is intact. Tracking shows the parcel arrived a day late after a stop at a regional depot.",
  },
  {
    name: "The Unexplained Photo",
    description:
      "A man finds a photo on his phone taken at 3:14 a.m. last Tuesday, showing a dark room with a faint light in one corner. He does not remember taking it. The phone was charging on his nightstand that night, and he lives with his partner and young son.",
  },
  {
    name: "The Abandoned Bag",
    description:
      "A zipped black duffel bag has stood beside a bench at a bus station for about four hours. It looks heavy, and its luggage tag is worn so the name cannot be read. Several passengers have walked past it without comment.",
  },
  {
    name: "The Hurried Visitor",
    description:
      "Shortly before a fire alarm sounded at a shopping centre, a man was seen walking quickly between shops and glancing at his watch. A staff member later said he had asked where the nearest pharmacy was. He left through a side exit about two minutes before the alarm, and the cause of the alarm has not been established.",
  },
];

// Deliberately minimal facts: no detail that favours a single explanation.
const VAGUE_SCENARIOS: Scenario[] = [
  { name: "The Red-Stained Cloth", description: "A cloth with dark red stains is discovered on the floor of an otherwise tidy room. The door was closed when it was found. Nobody knows how it got there." },
  { name: "The Night Noise", description: "A security guard hears three distinct knocks from an apparently empty office floor shortly after midnight. When the guard checks the corridor, nothing appears out of place." },
  { name: "The Damaged Parcel", description: "A parcel arrives with different tape sealing one side. The recipient notices that the package feels lighter than expected, but its contents have not yet been checked." },
  { name: "The Unexplained Photo", description: "A photograph appears on someone's phone overnight. It shows a dimly lit room and a shape near the doorway. The phone's owner does not remember taking it." },
  { name: "The Abandoned Bag", description: "A black bag is found beneath a bench in a public waiting area. It has no visible identification. Nobody nearby claims to recognise it." },
  { name: "The Hurried Visitor", description: "A person is seen leaving a building quickly shortly before an alarm sounds. Witnesses disagree about whether the person appeared frightened or simply in a hurry." },
];

const SCENARIO_SETS = { original: ORIGINAL_SCENARIOS, vague: VAGUE_SCENARIOS };

const PERSONAS: Persona[] = [
  { id: "analytical-detective", name: "Analytical Detective", approach: "Examine the observations systematically, consider alternative explanations, and identify inconsistencies." },
  { id: "creative-storyteller", name: "Creative Storyteller", approach: "Use contextual clues, imagination and narrative coherence to form a plausible explanation, while distinguishing speculation from evidence." },
  { id: "scientific-sceptic", name: "Scientific Sceptic", approach: "Prefer explanations supported by observable evidence and question unsupported assumptions." },
  { id: "investigative-journalist", name: "Investigative Journalist", approach: "Ask who, what, when and where; look for the detail that does not fit and for what is missing from the account." },
  { id: "behavioural-psychologist", name: "Behavioural Psychologist", approach: "Reason about what ordinary people typically do and why, paying attention to motives, habits and human error." },
  { id: "risk-analyst", name: "Risk Analyst", approach: "Weigh how likely each explanation is against the information available, and be explicit about what is uncertain." },
  { id: "pragmatic-engineer", name: "Pragmatic Engineer", approach: "Look for the simplest practical mechanism that accounts for the observations, the way you would diagnose a faulty system." },
  { id: "philosophical-thinker", name: "Philosophical Thinker", approach: "Examine what the observations actually establish, which assumptions you are making, and what could change your mind." },
  { id: "experienced-lawyer", name: "Experienced Lawyer", approach: "Separate established facts from inference, test each claim against the available information, and note what would need proving." },
  { id: "intuitive-observer", name: "Intuitive Observer", approach: "Trust your overall impression of how the pieces fit together, then check it against the stated observations." },
  { id: "forensic-researcher", name: "Forensic Researcher", approach: "Focus on physical details and timing, and reason carefully about what each could and could not have produced." },
  { id: "contextual-historian", name: "Contextual Historian", approach: "Consider the wider setting and precedent: what similar situations usually turn out to be, and what is particular to this one." },
];

// [Agent A persona id, Agent B persona id] per scenario, same order as SCENARIOS. No persona repeats in the batch.
const PAIRINGS: [string, string][] = [
  ["analytical-detective", "creative-storyteller"],
  ["scientific-sceptic", "investigative-journalist"],
  ["behavioural-psychologist", "risk-analyst"],
  ["pragmatic-engineer", "philosophical-thinker"],
  ["experienced-lawyer", "intuitive-observer"],
  ["forensic-researcher", "contextual-historian"],
];

const CORE_PROMPT = [
  "You are examining an ambiguous situation.",
  "Independently determine what you think most likely happened.",
  "Base your interpretation on the supplied observations.",
  "You may consider alternative explanations, but choose the one you currently find most plausible.",
  "Distinguish observations from speculation.",
  "Do not invent evidence.",
  "You are not required to disagree with anyone.",
  "You do not know another agent's interpretation.",
  "Your personality should influence your reasoning approach, not predetermine your conclusion.",
  "",
  'Reply with ONLY a JSON object, no markdown: {"interpretation":"short description of your chosen explanation","reasoning":"maximum 60 words","confidence":0-100 integer}',
].join("\n");

const config: ModelConfig = {
  provider: "openrouter",
  model: "deepseek/deepseek-v3.2",
  maxOutputTokens: 400,
  timeoutMs: 30_000,
  maxRetries: 0,
  temperature: 0.7,
};

// ---------- Setup checks (no network) ----------

const setArg = process.argv.slice(2).find((a) => a.startsWith("--scenario-set="));
const setName = setArg ? setArg.split("=")[1] : "original";
if (setName !== "original" && setName !== "vague") {
  console.error('--scenario-set must be "original" or "vague"');
  process.exit(1);
}
const SCENARIOS = SCENARIO_SETS[setName];

const personaById = new Map(PERSONAS.map((p) => [p.id, p]));
const used = PAIRINGS.flat();
if (PAIRINGS.length < SCENARIOS.length) throw new Error("Need one persona pairing per scenario");
if (used.some((id) => !personaById.has(id))) throw new Error("Pairing references an unknown persona id");
if (new Set(used).size !== used.length) throw new Error("A persona is repeated within the batch");
if (PAIRINGS.some(([a, b]) => a === b)) throw new Error("Agent A and B must not share a persona");

const args = process.argv.slice(2);
const swap = args.includes("--swap-personas");
const save = args.includes("--save");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : SCENARIOS.length;
if (!Number.isInteger(limit) || limit < 1 || limit > SCENARIOS.length) {
  console.error(`--limit must be an integer from 1 to ${SCENARIOS.length}`);
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set (put it in ai/.env or your shell environment).");
  process.exit(1);
}

// ---------- Helpers ----------

const opinionSchema = z.object({
  interpretation: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
  confidence: z.coerce.number().int().min(0).max(100),
});
type Opinion = z.infer<typeof opinionSchema>;

function parseOpinion(raw: string): { ok: true; value: Opinion } | { ok: false; reason: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, reason: "no JSON object in output" };
  try {
    const r = opinionSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return r.success ? { ok: true, value: r.data } : { ok: false, reason: `validation failed: ${r.error.issues[0]?.message}` };
  } catch {
    return { ok: false, reason: "output is not valid JSON" };
  }
}

const words = (t: string) => t.trim().split(/\s+/).length;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type AgentRecord = {
  agent: "A" | "B";
  persona: string;
  ok: boolean;
  interpretation?: string;
  reasoning?: string;
  confidence?: number;
  reasoningWords?: number;
  error?: string;
  rawOutput?: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

function toRecord(agent: "A" | "B", persona: Persona, o: GenerateOutcome): AgentRecord {
  if (!o.ok) {
    return { agent, persona: persona.name, ok: false, error: `[${o.error.kind}] ${o.error.message}${o.error.status ? ` (HTTP ${o.error.status})` : ""}` };
  }
  const m = o.result;
  const base = { agent, persona: persona.name, model: m.model, latencyMs: m.latencyMs, inputTokens: m.inputTokens, outputTokens: m.outputTokens, costUsd: m.costUsd, rawOutput: m.text };
  const p = parseOpinion(m.text);
  if (!p.ok) return { ...base, ok: false, error: `invalid output: ${p.reason}` };
  return { ...base, ok: true, ...p.value, reasoningWords: words(p.value.reasoning) };
}

function printAgent(r: AgentRecord) {
  console.log(`\n  Agent ${r.agent} — ${r.persona}`);
  if (r.ok) {
    console.log(`    Interpretation: ${r.interpretation}`);
    console.log(`    Reasoning:      ${r.reasoning}${r.reasoningWords! > 60 ? `  [note: ${r.reasoningWords} words, over the 60 limit]` : ""}`);
    console.log(`    Confidence:     ${r.confidence}`);
  } else {
    console.error(`    ERROR: ${r.error}`);
    if (r.rawOutput) console.error(`    Raw output: ${r.rawOutput}`);
  }
  if (r.model)
    console.log(`    ${r.model} | ${r.latencyMs} ms | tokens in/out ${r.inputTokens ?? "n/a"}/${r.outputTokens ?? "n/a"} | cost ${r.costUsd !== undefined ? "$" + r.costUsd : "n/a"}`);
}

// ---------- Run ----------

const started = Date.now();
const results: { scenario: Scenario; agents: [AgentRecord, AgentRecord]; assessment: string }[] = [];

for (let i = 0; i < limit; i++) {
  const scenario = SCENARIOS[i];
  let [idA, idB] = PAIRINGS[i];
  if (swap) [idA, idB] = [idB, idA];
  const [pA, pB] = [personaById.get(idA)!, personaById.get(idB)!];

  // Identical core prompt and scenario; only the persona line differs. Two separate parallel requests, no shared state.
  const ask = (p: Persona) =>
    generateText(config, { system: `${CORE_PROMPT}\n\nYOUR REASONING STYLE (${p.name}): ${p.approach}`, prompt: `SITUATION:\n${scenario.description}` });
  const [oA, oB] = await Promise.all([ask(pA), ask(pB)]);
  const agents: [AgentRecord, AgentRecord] = [toRecord("A", pA, oA), toRecord("B", pB, oB)];
  results.push({ scenario, agents, assessment: "not assessed" });

  console.log(`\n${"=".repeat(72)}\nScenario ${i + 1}/${limit}: ${scenario.name}\n${scenario.description}`);
  agents.forEach(printAgent);
}

const wallMs = Date.now() - started;
const all = results.flatMap((r) => r.agents);
const failed = all.filter((a) => !a.ok).length;
const costKnown = all.every((a) => a.costUsd !== undefined);
const totalCost = all.reduce((s, a) => s + (a.costUsd ?? 0), 0);

console.log(`\n${"=".repeat(72)}\nSUMMARY [scenario set: ${setName}]${swap ? " (personas swapped)" : ""} — agreement is NOT auto-assessed; review the interpretations manually.\n`);
console.table(
  results.map((r) => ({
    scenario: r.scenario.name,
    "A persona": r.agents[0].persona,
    "A interpretation": clip(r.agents[0].interpretation ?? "(error)", 50),
    "A conf": r.agents[0].confidence ?? "-",
    "B persona": r.agents[1].persona,
    "B interpretation": clip(r.agents[1].interpretation ?? "(error)", 50),
    "B conf": r.agents[1].confidence ?? "-",
    "agree/disagree": r.assessment,
  })),
);
console.log(`Calls: ${all.length} | failed: ${failed} | wall-clock: ${wallMs} ms | total reported cost: ${costKnown ? "$" + totalCost : "n/a (not reported for every call)"}`);

if (save) {
  const dir = path.join(import.meta.dirname, "..", "test-output");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `persona-opinions-${setName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: config.model, temperature: config.temperature, scenarioSet: setName, swapped: swap, wallMs, totalCostUsd: costKnown ? totalCost : null, results }, null, 2));
  console.log(`Full results saved to ${file}`);
}

if (failed) {
  console.error(`${failed} agent call(s) failed or returned invalid output (not retried).`);
  process.exitCode = 1;
}
