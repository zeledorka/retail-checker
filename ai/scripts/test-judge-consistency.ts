// MANUAL LIVE TEST (billed): does the judge pick the same underlying arguments when the A/B labels are swapped?
//   npm run test:judge-consistency                 one repetition  = 2 judge requests
//   npm run test:judge-consistency -- --reps=5     five repetitions = 10 judge requests
// Same fixed scenario and completed transcript; condition "swapped" exchanges the labels and interpretations only.
// Only the judge is called (TEST_JUDGE_PROVIDER / TEST_JUDGE_MODEL, default OpenRouter deepseek/deepseek-v3.2).
// Inference is stochastic: a disagreement is a data point, not proof of bias; use several repetitions.
import { createDebateEngine } from "../src/index";
import type { JudgeResult, Scenario, Side, TranscriptEntry } from "../src/types";
import { flip, swapLabels } from "./judge-swap";
import { loadEnv, makeTracker, requireKeys, testEngineConfig } from "./lib";

loadEnv();

const repsArg = process.argv.find((a) => a.startsWith("--reps="));
const reps = repsArg ? Number(repsArg.split("=")[1]) : 1;
if (!Number.isInteger(reps) || reps < 1 || reps > 20) {
  console.error("--reps must be an integer from 1 to 20");
  process.exit(1);
}

// Test data lives only in this script.
const scenario: Scenario = {
  title: "The Red-Stained Cloth",
  description:
    "A cloth with dark red stains is discovered on the floor of an otherwise tidy room. The door was closed when it was found. Nobody knows how it got there.",
  evidence: [
    "A cloth with dark red stains was on the floor of the room",
    "The room was otherwise tidy",
    "The door was closed when the cloth was found",
    "Nobody knows how the cloth got there",
  ],
  interpretationA: "An accidental spill: the stains come from something ordinary being spilled.",
  interpretationB: "Evidence of a possible violent incident: the stains may be real blood.",
};

const say = (turn: number, side: Side, text: string, stage: TranscriptEntry["stage"] = "turn"): TranscriptEntry =>
  stage === "turn" ? { stage, side, text, turn } : { stage, side, text };
const transcript: TranscriptEntry[] = [
  say(1, "A", "A tidy room, a closed door, one stained cloth. That is the signature of an ordinary accident: something spilled, wiped up, forgotten. Violence leaves disorder. Nothing in these facts shows disorder, so the simplest explanation wins.", "opening"),
  say(2, "B", "A closed door and no explanation for the cloth is exactly what concealment looks like. Dark red stains are consistent with blood. I do not claim certainty, but an innocent spill rarely goes unmentioned, and nobody here can say how this cloth arrived.", "opening"),
  say(3, "A", "Consistent with blood is not evidence of blood; plenty of things stain red. You lean on 'nobody can explain it', but unexplained is not suspicious. Rooms get tidied, cloths get dropped, memories fade. What is the actual indication of harm?"),
  say(4, "B", "I grant the stains prove nothing alone. My case is the combination: closed door, tidy room, no account. If someone spilled a drink, why stay silent? Silence is a fact; harm is the possibility it makes worth taking seriously."),
  say(5, "A", "Silence is not a fact about this cloth; it is missing information, and a missing explanation is not an explanation. A tidy room argues against a struggle. You are building a crime from a gap, which is speculation dressed as suspicion."),
  say(6, "B", "Fair, I am speculating, and I call it a possibility. But a tidy room can follow a cleanup as easily as a calm evening. Your spill theory has the same gap: nobody reports spilling anything. Both stories need a missing witness."),
  say(7, "A", "Agreed that both need a missing witness. The difference is cost: a spill needs nothing unusual, no injury and no cleanup. Your version needs a victim, an injury and a cover-up, none of which anyone has reported. Fewer assumptions makes mine likelier."),
  say(8, "B", "Fewer assumptions is not more evidence. A closed door shut on a stained cloth is something the spill theory has to explain away. I do not need a victim to say the stains deserve investigation; I only need reasonable doubt."),
];

const config = testEngineConfig();
requireKeys({ ...config, agentA: config.judge, agentB: config.judge }, true); // only the judge is called
const tracker = makeTracker();
const engine = createDebateEngine(config, { onModelCall: tracker.onModelCall });
const swapped = swapLabels(scenario, transcript);
const started = Date.now();

type Row = { condition: "original" | "swapped"; result: JudgeResult };
const summary: { rep: number; origWinner?: Side; swappedMappedWinner?: Side }[] = [];
let labelAWins = 0;
let judged = 0;
let failed = false;

function show(r: Row, rep: number) {
  console.log(`\n  [${r.condition}]`);
  if (!r.result.ok) {
    failed = true;
    console.error(`    ERROR: [${r.result.error.kind}] ${r.result.error.message}`);
    return undefined;
  }
  const v = r.result.verdict;
  const toOriginal = (label: Side): Side => (r.condition === "original" ? label : flip(label));
  const winner = toOriginal(v.winner);
  console.log(`    Winner label: ${v.winner}${r.condition === "swapped" ? ` -> original identity ${winner}` : ""}`);
  for (const label of ["A", "B"] as const) {
    const s = v.scores[label];
    console.log(`    Original Agent ${toOriginal(label)} (shown as ${label}): evidence ${s.evidence}, logic ${s.logic}, rebuttal ${s.rebuttal}, persuasion ${s.persuasion}`);
  }
  console.log(`    Explanation: ${v.explanation}`);
  const m = r.result.meta;
  console.log(`    (${m.model} | ${m.latencyMs} ms | tokens in/out ${m.inputTokens ?? "n/a"}/${m.outputTokens ?? "n/a"}${m.reasoningTokens ? ` (reasoning ${m.reasoningTokens})` : ""} | cost ${m.costUsd !== undefined ? "$" + m.costUsd : "n/a"})`);
  judged++;
  if (v.winner === "A") labelAWins++;
  return winner;
}

console.log(`Judge: ${config.judge.provider}:${config.judge.model} | repetitions: ${reps} | requests: ${reps * 2}`);
for (let rep = 1; rep <= reps; rep++) {
  console.log(`\n${"=".repeat(72)}\nRepetition ${rep}/${reps}`);
  const [orig, swap] = await Promise.all([
    engine.judgeDebate({ roundId: `judge-consistency-${rep}-orig`, scenario, transcript }),
    engine.judgeDebate({ roundId: `judge-consistency-${rep}-swap`, scenario: swapped.scenario, transcript: swapped.transcript }),
  ]);
  const o = show({ condition: "original", result: orig }, rep);
  const s = show({ condition: "swapped", result: swap }, rep);
  summary.push({ rep, origWinner: o, swappedMappedWinner: s });
  if (o && s) console.log(`\n  Same underlying winner after remapping: ${o === s ? "YES" : "NO"} (original ${o}, swapped->${s})`);
}

console.log(`\n${"=".repeat(72)}\nSUMMARY`);
for (const r of summary) {
  const same = r.origWinner && r.swappedMappedWinner ? (r.origWinner === r.swappedMappedWinner ? "same" : "DIFFERENT") : "n/a (error)";
  console.log(`  rep ${r.rep}: original winner ${r.origWinner ?? "-"}, swapped winner mapped back ${r.swappedMappedWinner ?? "-"} -> ${same}`);
}
const comparable = summary.filter((r) => r.origWinner && r.swappedMappedWinner);
console.log(`Consistent after remapping: ${comparable.filter((r) => r.origWinner === r.swappedMappedWinner).length}/${comparable.length} comparable repetitions`);
console.log(`Verdicts naming label "A": ${labelAWins}/${judged} (a position preference would show up here, but small samples are noisy)`);
console.log(`Total ${tracker.summary()} | wall-clock: ${Date.now() - started} ms`);
if (failed) process.exitCode = 1;
