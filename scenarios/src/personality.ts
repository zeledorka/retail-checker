import type { Personality, Side } from "./types";

/** 32-bit FNV-1a over the parts: a stable way to derive independent seeds ("round seed" + "A", ...). */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("\u0000")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
}

/** Small seeded generator (mulberry32): the same seed always yields the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh random seed. Store it with the round: it reproduces the personalities and the tie-breaking. */
export function newSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Independent, reproducible personality for one side. Seven continuous traits in [0.05, 0.95]: there is no archetype list, so
 * combinations barely repeat. A and B draw from separate generators (seeded by the round seed AND the side).
 */
export function generatePersonality(roundSeed: number, side: Side): Personality {
  const rand = mulberry32(hashSeed("personality", roundSeed, side));
  const t = () => r2(0.05 + 0.9 * rand());
  return {
    seed: roundSeed,
    side,
    evidenceScepticism: t(),
    inferenceWillingness: t(),
    riskTolerance: t(),
    simplicityPreference: t(),
    directness: t(),
    rhetoricalFlourish: t(),
    rebuttalAggression: t(),
  };
}

const band = (v: number, words: [string, string, string, string, string]) => words[Math.min(4, Math.floor(v * 5))];
/** How a trait changes the WEIGHING of evidence: low / middle / high third. Nothing here forces a particular conclusion. */
const weigh = (v: number, low: string, mid: string, high: string) => (v < 0.4 ? low : v < 0.6 ? mid : high);

/**
 * The text given to the ranking model for ONE side's own personality. It shapes preference and style only and states plainly
 * that it never allows invented facts. Server-side: never shown to the other agent, the judge or the frontend.
 */
export function describePersonality(p: Personality): string {
  return [
    `Evidence standard: ${band(p.evidenceScepticism, ["accepts plausible readings readily", "fairly relaxed about proof", "balanced about proof", "demands solid support before agreeing", "very sceptical, wants close support for every step"])}. ${weigh(p.evidenceScepticism, "You count a plausible reading as defensible even if some links are assumed.", "You accept moderate gaps but not large ones.", "You mark down any reading that depends on a claim the evidence does not support.")}`,
    `Inference: ${band(p.inferenceWillingness, ["sticks closely to what is directly observed", "cautious about inferring", "draws moderate inferences", "readily infers motives and causes", "eager to infer the unseen from small clues"])}. ${weigh(p.inferenceWillingness, "You give little weight to evidence that only works through an inference.", "You give indirect evidence moderate weight.", "You give real weight to indirect evidence that fits together coherently.")}`,
    `Risk: ${band(p.riskTolerance, ["prefers the safest, least contestable reading", "leans cautious", "neutral about risk", "likes a bolder reading", "enjoys a daring, contrarian reading"])}. ${weigh(p.riskTolerance, "You favour the reading that is hardest to attack.", "You weigh safety and boldness about equally.", "You are willing to rank a bolder reading highly if it can still be defended.")}`,
    `Explanations: ${band(p.simplicityPreference, ["comfortable with intricate, many-part explanations", "tolerates complexity", "no strong preference", "prefers simple explanations", "strongly prefers the simplest explanation"])}. ${weigh(p.simplicityPreference, "A many-part reading is not marked down for needing several assumptions.", "You mildly prefer readings with fewer assumptions.", "You mark down readings that need many separate assumptions.")}`,
    `Argument style: ${band(p.directness, ["indirect and measured", "somewhat measured", "even-handed", "direct", "blunt and to the point"])}; ${band(p.rhetoricalFlourish, ["plain wording", "mostly plain wording", "some colour", "vivid wording", "theatrical flair"])}; ${band(p.rebuttalAggression, ["gentle with opposing points", "polite when disagreeing", "firm but fair", "pressing", "relentless in attacking weak points"])}.`,
    "The first four traits change how you weigh the evidence for each candidate; the style traits only describe how you would argue. You are not required to reach a different reading from anyone else. They never allow you to invent facts, witnesses or findings, and they never override the evidence.",
  ].join("\n");
}
