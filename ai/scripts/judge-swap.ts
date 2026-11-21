// Pure helpers for the judge-consistency experiment (manual scripts and tests only).
import type { Scenario, Side, TranscriptEntry } from "../src/types";

export const flip = (s: Side): Side => (s === "A" ? "B" : "A");

/**
 * Exchanges the A/B labels and the matching interpretations. The arguments themselves, their order,
 * stages and turn numbers are untouched, so the judge sees the same debate with the sides' labels reversed.
 */
export function swapLabels(scenario: Scenario, transcript: TranscriptEntry[]): { scenario: Scenario; transcript: TranscriptEntry[] } {
  return {
    scenario: { ...scenario, interpretationA: scenario.interpretationB, interpretationB: scenario.interpretationA },
    transcript: transcript.map((e) => ({ ...e, side: flip(e.side) })),
  };
}
