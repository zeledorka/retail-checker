# Pre-round preparation: how Developer 3 gets the locked scenario

Code: `scenarios/` (this folder). It does **not** change the debate system in `ai/`; it only imports its types and `generateText`.
Checks: `cd scenarios && npm install && npm run typecheck && npm test` (`ai/` needs its own `npm install`; files are imported from there).

There are **two pipelines**. Use the first. The second is kept for history and comparison.

| | Current: independent opinion generation | Legacy: candidate ranking |
|---|---|---|
| Entry point | `prepareScenario` | `prepareRound` / `prepareFromPool` |
| Input | `ScenarioInput` (description + evidence with ids `e1…`), **no interpretations** | `ScenarioCase` with 3-4 pre-written interpretations |
| Agents | each writes **its own three** interpretations | each ranks the pre-written ones |
| Checker | one blind semantic checker request | none |
| Requests | **3** (2 parallel + 1) | 2 per attempt |
| Files | `opinions.ts`, `checker.ts`, `opinion-selector.ts`, `prepare-opinions.ts`, `scenario-input.ts`, `opinion-types.ts` | `ranking.ts`, `selector.ts`, `prepare.ts`, `generator.ts`, `prepared-cases.ts` (candidates) |

## Current architecture (three requests, then local selection)

1. **Generation (2 parallel Sonnet 5.5, low effort).** Agent A and Agent B get the identical scenario and numbered evidence plus **only their own** random personality (seven continuous traits from the seed). Each returns exactly three interpretations: title, causal explanation, supporting evidence ids, weaknesses, rank 1-3, self-assessed defensibility (argument strength, not a probability of truth). Invented evidence ids, wrong counts, repeated ranks or bad scores are rejected. Agents are not told to disagree and never see each other's output.
2. **Checker (1 Sonnet 5.5 request).** Sees the scenario and all six opinions under anonymous ids `o1…o6` in a seeded shuffled order. It does **not** see sides, personalities, ranks, self-scores, bets, audience data or debate history. It does not choose a winner. This is a game, not a trial: it judges whether an opinion is *reasonably arguable*, not proven or likely. Returns per opinion a defensibility 0-100 (the ability to build a coherent, evidence-consistent argument, **not** the probability of being right) and a flag, plus semantic-equivalence groups (same mechanism, different wording; different actors doing the same act are one explanation) and, for all 15 pairs, a difference score and whether they form a meaningful disagreement. If its reply is invalid it is repeated once (`checkerRetries`, default 1); provider errors are never repeated.
   * Scale: 0-19 implausible/contradictory/unconnected; 20-29 extremely speculative; **30-44 speculative but reasonably arguable**; 45-69 plausible with some support; 70-100 strongly defensible.
   * Flags: `ok` (plausible), `speculative` (plausible, rests on unverified assumptions: **eligible**), `contradicted` (the evidence shows it could not have happened) and `implausible` (needs an implausible mechanism or fabricated "facts"): both ineligible whatever the score. `unsupported` is a legacy flag, still accepted (eligible, small penalty). Absence of proof is **not** contradiction.
3. **Final selection (local, no request).** The anonymous ids are mapped back to agents and the nine A-B pairs are evaluated. An opinion is **eligible** when its checker score is at least **30** (`minDefensibility`, configurable) and it is not `contradicted`/`implausible`. Rejected pairs: an ineligible opinion, same-explanation pairs, non-meaningful or low-difference (<40) pairs, pairs whose scores differ by more than 30. Score = mean checker defensibility + 0.25 x difference + modest rank bonus (6/3/0) - 0.3 x gap - 8 per legacy `unsupported` (none for `speculative`). Pairs within 2 points of the best are drawn with the seed; ties are ordered by content, not by label or list position. No viable pair returns an explicit `no_credible_opposing_pair` failure (stage `selection`): pick or generate another scenario, never force the debate. Thresholds are in `DEFAULT_SELECTION`. The threshold was lowered from 45 to 30 after the first live benchmarks (see below).

## Call sequence

```ts
import { generateText, startRound } from "<path>/ai/src/index";
import { PREPARED_SCENARIOS, createLlmChecker, createLlmOpinionGenerator, newSeed, prepareScenario } from "<path>/scenarios/src/index";

const seed = newSeed();                                   // store it: reproduces personalities, checker order and tie-breaking
const prep = await prepareScenario({ scenario: PREPARED_SCENARIOS[i], seed, generator: createLlmOpinionGenerator(generateText), checker: createLlmChecker(generateText) });
if (!prep.ok) { /* prep.stage: input | generation | checker | selection; choose another scenario or retry later */ }
const started = startRound({ roundId, scenario: prep.scenario });   // prep.scenario is exactly the startRound input
// store prep.meta server-side; show prep.publicScenario to players
```

| Field | Use | Visibility |
|---|---|---|
| `scenario` | exact `startRound` input (title, description, evidence texts, `interpretationA`, `interpretationB`) | server; stored by the AI round |
| `publicScenario` | same fields (+ optional `imagePath`) | frontend |
| `meta` | seed, personalities, all six opinions, checker order and report (assessments, groups, 15 pairs), selection diagnostics, `locked: { A, B }`, telemetry, `llmCalls` | **server-only**: never to the judge, debating agents or browser |

Scenarios: `PREPARED_SCENARIOS` are the six prepared cases converted to scenario-only inputs (their old candidate lists are not sent anywhere). `validateScenarioInput` checks new ones (3-8 evidence items, unique ids). No images are generated.

## Status

| Part | Status |
|---|---|
| generation, checker, selector, orchestration, startRound compatibility | **working and tested with mocks** (`npm test`, 110 tests) |
| blindness of the checker request, no cross-agent leakage, label swap and order shuffle | tested with a content-keyed mock checker (0 differences in 180 runs): this shows the *pipeline* adds no bias, **not** that a real model is unbiased |
| live generation and checker (`createLlmOpinionGenerator`, `createLlmChecker`) | written against `generateText`; **never run against a live model**. Prompts, 15-pair output format and thresholds are untested |
| image generation | not implemented |

## Live benchmark (not yet run; needs explicit approval)

`scripts/benchmark-opinions.ts` (`npm run benchmark:opinions`):

```
npx tsx scripts/benchmark-opinions.ts                                  # plan and estimate only, makes no request
npx tsx scripts/benchmark-opinions.ts --approved --env-file=<ai/.env>  # 2 scenarios x (2 generation + 1 checker) = 6 requests
npx tsx scripts/benchmark-opinions.ts --approved --approve-recheck --env-file=<ai/.env>   # +1 checker repeat per scenario (8 total)
```

Defaults: `empty-display-case` and `silent-call` (`--cases=a,b`), seeds 2026 and 2027 (`--seed=`). No retries, hard cap on requests. It prints each personality, all six opinions, checker assessments, equivalence groups, all 15 pair judgements, selection diagnostics, the locked pair, and per-request latency, tokens and estimated cost. With `--approve-recheck` the checker is asked again over the same opinions in a different shuffled order and the script reports the change in each defensibility score and whether the selected pair changed. Look for: valid JSON on the first try, whether generated readings are distinct, whether the checker groups paraphrases, whether defensibility is spread rather than all high or low, whether a credible pair exists, and order sensitivity.

Legacy ranking material (`validation/`, `scripts/evaluate-live.ts`, `prepareRound`) is unchanged and still works.

## Benchmark history and replay

`validation/live-opinions-*.json` are the saved results of the first two live runs (kept unmodified). At the old threshold of 45 four of the five scenario runs failed (usable opinions 1/1 or 1/2): the checker scored most opinions 25-45 and never used `contradicted`, and both agents converged on the same two explanations. `npx tsx scripts/replay-selection.ts` re-runs **only the selector** on those recorded checker verdicts (no network, no cost). At threshold 30 all four previously failed runs would select a pair, and the one earlier success is unchanged. That is a selector-only replay: it cannot show how the new checker prompt (speculative flag, new scale) will score or flag the same opinions, so the live benchmark must be repeated.
