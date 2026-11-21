# Pre-round preparation: how Developer 3 gets the locked scenario

Code: `scenarios/` (this folder). It does **not** change the debate system in `ai/`; it only imports its types and `generateText`.
Checks: `cd scenarios && npm install && npm run typecheck && npm test` (`ai/` needs its own `npm install`; files are imported from there).

## START HERE: `prepareNewRound` (new scenario + image + locked opinions)

One call creates an entirely new ambiguous case, a matching image and two opposing interpretations. Run it **before** the timed round.

```ts
import { generateText, startRound } from "<path>/ai/src/index";
import { createLlmChecker, createLlmOpinionGenerator, createOpenRouterImageGenerator, newSeed, prepareNewRound } from "<path>/scenarios/src/index";

const prep = await prepareNewRound({
  seed: newSeed(),                                   // store it
  generate: generateText,                            // scenario writer (Claude)
  generator: createLlmOpinionGenerator(generateText),
  checker: createLlmChecker(generateText),
  imageGenerator: createOpenRouterImageGenerator(),  // reads OPENROUTER_API_KEY / OPENROUTER_IMAGE_MODEL
  recentTitles,                                      // optional: titles of recent rounds, to avoid repeats
  fallbackToPrepared: true,                          // optional last resort (no generated image, see below)
});
if (!prep.ok) { /* prep.stage: scenario | opinions | image | fallback; prep.message; try again or pick another path */ }
const started = startRound({ roundId, scenario: prep.scenario });   // exactly the startRound input
```

**Flow:** 1 Claude request writes the case (and privately designs 2-3 different explanations) → local validation → **in parallel**: 1 OpenRouter image request, and the opinion pipeline below (2 parallel Claude generations, 1 blind checker, local selection). Normal path: **5 provider requests**, two overlapping. Retries are bounded: if the opinions fail (no credible pair, insufficient diversity, checker failure) a **new** scenario is written (`maxScenarioAttempts`, default 2); a failed scenario is never forced into a debate. If only the image fails, only the image is retried (`imageRetries`, default 1); the opinion requests are never repeated, and a final image failure returns `stage: "image"` with `preserved` (scenario + opinions) so you can retry the image alone.

**What you get on success (`PreparedRound`):**

| Field | Contents | Visibility |
|---|---|---|
| `scenario` | exact `startRound` input (title, description, evidence texts, `interpretationA`, `interpretationB`) | server; stored by the AI round |
| `publicCase` | `scenarioId`, `title`, `description`, `evidence: {id,text}[]`, `interpretationA/B`, `image` (JSON-safe info: id, filename, mimeType, byteLength, sha256, model; **no bytes**), optional `localImagePath` | public / safe for storage |
| `image` | `ImageAsset`: `bytes` (Uint8Array), `mimeType`, `filename`, `sha256`, `model`, `prompt`. **You upload `image.bytes` to Supabase Storage** and put the resulting URL in your own state. Never put bytes or base64 in AI round JSON. `null` only for a fallback case | server |
| `source` | `"generated"` or `"fallback"` (a prepared case; **no image was generated**: `image` is `null`, `server.imageStatus` is `"fallback_without_image"`) | server |
| `server` | seed, scenario seed, private `design`, all opinion metadata (personalities, six opinions, checker report, selection diagnostics, `locked`), models, `timing` (scenario / image / opinions / parallel / total ms), `requests`, `usage` (tokens, estimated Claude cost, actual image cost when reported), `attempts` | **server-only**: never to the judge, debating agents or browser |

Failures are typed (`ok: false`, `stage`, `message`, `attempts`, `requests`, `timing`). Image errors have codes `missing_key`, `unsupported_model`, `invalid_response`, `http_error`, `timeout`, `network`; the model is never swapped silently. You own the multiplayer state, Supabase upload and phases; this code only prepares the case.

**Image:** OpenRouter Images API, `POST https://openrouter.ai/api/v1/images`, model `google/gemini-3.1-flash-lite-image` (verified listed on 2026-11-21 via `GET /api/v1/images/models`: 16:9 supported, one image per request, billed per output token), `b64_json` decoded to real bytes, type verified from the bytes. One landscape image per round. The image prompt uses **public facts only** (never the private designs). No OpenAI key or SDK.

**Environment variables** (see `.env.example`; never commit keys): `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_IMAGE_MODEL` (optional; default above).

**Privacy of the case design:** the scenario writer's private "designs" are quality-control data kept in `server.design`. They never reach the agents, the checker, the judge, the image prompt or the frontend. A designer's claim that a case is balanced proves nothing: the independent opinion checker remains the real gate (hence the retry with a new scenario).

**Status:** everything above is tested with mocks (`npm test`). The live scenario writer and the OpenRouter call have **never run live**. Benchmark them first (needs explicit approval; 5 paid requests, no retries or fallback; dry-run by default):

```
npx tsx scripts/benchmark-full-generation.ts                                  # plan only, zero requests
npx tsx scripts/benchmark-full-generation.ts --approved --env-file=<ai/.env>  # npm run benchmark:full -- --approved ...
```
It prints the public case, the private design (separately), the image path, all six opinions, checker verdicts, the selected pair, measured times, estimated Claude cost and the actual image cost reported by OpenRouter. Generated files go to the git-ignored `scenarios/output/` (image, public scenario JSON, a raw dump without keys or image bytes).

The opinion-selection stage is documented in the sections below and is unchanged. The six prepared cases remain as emergency fallbacks.

---

There are **two opinion pipelines** below. Use the first. The second is kept for history and comparison.

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
| generation, checker, selector, orchestration, startRound compatibility | **working and tested with mocks** (`npm test`, 170 tests) |
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

## Checker reply validation

The checker reply must contain exactly six assessments (ids `o1`-`o6`, each once), the equivalence groups, and all 15 pairs, with no other id. The request lists the valid ids and counts. Only harmless structural differences are repaired locally and are listed in `checkerReport.normalisations` (shown in diagnostics): id case or spacing, identical repeated entries, and an **empty placeholder assessment** (score 0, flag `ok`, no note) for an id that does not exist (first seen as `o7` in the first full benchmark). Anything else is rejected as `invalid_output`: a missing real assessment, an unknown id inside a group or pair, an extra entry with content, conflicting repeats, wrong pair count, truncated JSON. No judgment is ever invented or remapped, and no extra model call is made on the normal path (an invalid reply is still retried once by `prepareScenario` unless `checkerRetries: 0`).

## Complete-game integration benchmark (`scripts/benchmark-complete-game.ts`)

One integrated round using only the existing public APIs: `prepareNewRound` (new scenario, image, independent opinions) -> `startRound({ maxTurns: 8 })` -> `createAiRound` (Sonnet 5.5, low effort, SDK retries 0, judge parse retries 0) -> opening A, opening B, eight turns with a cumulative simulated audience of **200** (100 per side, one per player, built locally and deterministically by `src/audience-sim.ts`, no model call) -> one `judge`. Library entry point: `runCompleteGame` (`src/complete-game.ts`). Paid path: **15 Claude + 1 image = 16 requests**, hard-capped, no retries, no fallback; a failed essential stage stops the run and keeps partial outputs.

```
npx tsx scripts/benchmark-complete-game.ts                                  # plan + configuration check, ZERO requests
npx tsx scripts/benchmark-complete-game.ts --approved --env-file=<ai/.env>  # the paid run (needs explicit approval)
```
Outputs go to the git-ignored `scenarios/output/game-<timestamp>/`: `public/` (case, image, positions, transcript .json/.md, judgment), `private/` (the 200 synthetic submissions with their kinds, preparation metadata, per-turn audience diagnostics, final state, request log) and `report.json` / `report.md` (timings, critical path, parallelism, tokens, cost estimate, pass/fail checks). Checks marked `review` need a human read (for example whether an unverified claim was framed as unverified). The 200 simulated users test audience processing and scalability only: this is **not** a real 200-client multiplayer load test, and it has **not** been run live yet.
