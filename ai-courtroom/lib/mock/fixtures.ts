// Static fixtures for MOCK MODE. Shapes follow the real AI contract (Scenario, PublicArgument, JudgeVerdict).
import type { JudgeVerdict, Scenario, Side } from "@/lib/types";

export const MOCK_ROUND_ID = "00000000-0000-4000-8000-00000000c0de";

export const MOCK_SCENARIO: Scenario = {
  title: "The Crimson Storeroom",
  description:
    "A dark red substance is discovered on the floor of a locked storage room the morning after the school Halloween event. The caretaker found it at 7am and called it in.",
  evidence: [
    "A reddish, slightly sticky stain covers about a metre of the floor",
    "Halloween decorations were packed into the room late last night",
    "A mop and bucket of cleaning equipment stand nearby, recently used",
    "The room was locked overnight and only two staff hold keys",
  ],
  interpretationA: "It's a Halloween prop: fake blood that leaked from the stored decorations.",
  interpretationB: "It's evidence of violence: real blood, and someone tried to clean it up.",
};

export const MOCK_IMAGE_URL: string | null = null; // the real backend may provide case.imageUrl

/** 10 public arguments: openings (seq 1-2) then 8 alternating debate turns (seq 3-10). Each <= 45 words. */
export const MOCK_LINES: { side: Side; text: string }[] = [
  { side: "A", text: "Members of the jury: decorations went in last night, a stain appeared by morning. Fake blood is sold by the litre for Halloween. The simplest explanation is a leaking prop, not a crime." },
  { side: "B", text: "A locked room, a fresh stain, and a mop that was recently used. Props don't clean up after themselves. Someone with a key was in that room and tried to hide what happened." },
  { side: "A", text: "My opponent treats a mop as a confession. Cleaning gear lives in storerooms. If someone scrubbed the floor, why is a metre-wide stain still sitting there? That's a spill nobody noticed." },
  { side: "B", text: "Sticky is the key word. Dried blood gets tacky; theatre blood is often syrup that stays wet. And only two people hold keys, which narrows this to a very short list of suspects." },
  { side: "A", text: "Corn-syrup fake blood is famously sticky. That detail helps me. And a short key list cuts both ways: the same staff carried in the decorations at night, in a hurry, in the dark." },
  { side: "B", text: "Hurry is exactly my point. Rushed people make mistakes, and mistakes cause injuries. The defence has not shown a single broken bottle of fake blood among those decorations." },
  { side: "A", text: "Nor has the prosecution shown an injury, a victim, a weapon or a missing person. Evidence of violence needs violence. All we have is red liquid near Halloween boxes the morning after Halloween." },
  { side: "B", text: "Absence of a reported victim the next morning proves nothing. The partial clean-up shows awareness. People don't half-mop syrup at midnight; they do it when they panic." },
  { side: "A", text: "Or they do it because the caretaker mops that floor nightly. The bucket being 'recently used' is routine. Test the stain: I'm confident the lab finds sugar and dye, not haemoglobin." },
  { side: "B", text: "Confidence isn't evidence. Unexplained stain, locked access, partial clean-up. Until it's tested, the cautious reading is the one that protects a possible victim. That reading is mine." },
];

export const MOCK_VERDICT: Record<Side, JudgeVerdict> = {
  A: {
    winner: "A",
    explanation:
      "Agent A anchored every claim to the evidence list: the timing of the decorations, the stickiness of syrup-based fake blood, and the routine presence of cleaning gear. Agent B raised fair doubts but never produced evidence of an injury.",
    summary: "The prop theory fit the evidence more tightly.",
    scores: {
      A: { evidence: 8, logic: 8, rebuttal: 7, persuasion: 7 },
      B: { evidence: 6, logic: 7, rebuttal: 6, persuasion: 7 },
    },
    overall: { A: 7.5, B: 6.5 },
    strengths: {
      A: ["Tied the stain's timing to the decorations being stored", "Turned the 'sticky' detail into support for corn-syrup fake blood"],
      B: ["Pressed hard on the restricted key access", "Kept asking why a prop container was never found"],
    },
    weaknesses: {
      A: ["Assumed the floor is mopped nightly without evidence"],
      B: ["Never identified an injury, victim or weapon", "Leaned on 'panic' as a motive with no support"],
    },
    decisiveExchange: { refs: ["E7", "E8"], description: "A's demand for an injury or victim went unanswered by B." },
  },
  B: {
    winner: "B",
    explanation:
      "Agent B built a consistent chain from restricted key access to the partial clean-up, and pressed Agent A on the missing prop container. Agent A's rebuttals relied on assumptions about routine cleaning that were not in the evidence.",
    summary: "The cover-up reading went unanswered on key points.",
    scores: {
      A: { evidence: 6, logic: 7, rebuttal: 5, persuasion: 6 },
      B: { evidence: 7, logic: 8, rebuttal: 8, persuasion: 7 },
    },
    overall: { A: 6, B: 7.5 },
    strengths: {
      A: ["Clear, simple opening anchored to the Halloween timing"],
      B: ["Built a consistent chain from key access to the partial clean-up", "Exposed the missing prop container"],
    },
    weaknesses: {
      A: ["Rebuttals relied on routine cleaning that is not in the evidence", "Did not answer the key-access point"],
      B: ["The 'sticky means dried blood' claim is contestable"],
    },
    decisiveExchange: { refs: ["E5", "E6"], description: "B's challenge on the missing fake-blood container was never answered." },
  },
};

export const MOCK_BOTS: { nickname: string; tokens: number; correctPicks: number; side: Side; stake: number }[] = [
  { nickname: "JudgeJudy99", tokens: 160, correctPicks: 3, side: "A", stake: 40 },
  { nickname: "ObjectionRay", tokens: 135, correctPicks: 2, side: "B", stake: 25 },
  { nickname: "GavelGirl", tokens: 120, correctPicks: 2, side: "A", stake: 10 },
  { nickname: "Sherlock_H", tokens: 110, correctPicks: 1, side: "B", stake: 50 },
  { nickname: "Perry M.", tokens: 95, correctPicks: 1, side: "A", stake: 20 },
  { nickname: "LawAndOrder", tokens: 80, correctPicks: 1, side: "B", stake: 30 },
  { nickname: "TheBailiff", tokens: 60, correctPicks: 0, side: "A", stake: 15 },
  { nickname: "ExhibitB", tokens: 40, correctPicks: 0, side: "B", stake: 10 },
];
