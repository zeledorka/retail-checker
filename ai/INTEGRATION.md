# AI Courtroom: AI subsystem integration contract (Developer 3)

Status: the AI subsystem is frozen. This document describes how the game backend calls it. Everything below was read from the
code in `ai/src` (`round.ts`, `debate.ts`, `themes.ts`, `config.ts`) and is exercised by `test/integration.test.ts` with a mocked
provider. It has **not** been run inside a Next.js build or against Supabase (see "Not verified" at the end).

## 1. Boundaries

| Owner | Responsibility |
|---|---|
| **AI subsystem (this folder)** | two debating agents, audience processing and semantic grouping, per-round AI memory (a JSON state), the independent judge |
| **Developer 2** | scenario generation and validation (title, description, evidence, **two locked, different interpretations**), frontend |
| **Developer 3** | Next.js routes, Vercel, Supabase, rooms, player ids and auth, **one submission per player per round**, the game clock, bets and payouts, calling this module, storing its state |

The AI module never generates or edits the scenario or the interpretations, never touches Supabase, never starts timers or
background work, and holds no memory between calls. Every call is: **load state -> call one function -> save the returned state.**

## 2. Public API

Import from the single entry point (`ai/src/index.ts`):

```ts
import { startRound, createAiRound, parseRoundState, serializeRound, publicRoundView } from "<path to>/ai/src/index";
import type { AiRoundState, AudienceSubmission, AiError, PublicArgument, TurnStep, OpeningStep, JudgeStep, PublicRoundView, Scenario } from "<path to>/ai/src/index";
```

| Function | Model requests | Purpose |
|---|---|---|
| `startRound({ roundId, scenario, maxTurns? })` | 0 | validates and creates the first `AiRoundState` (revision 0) |
| `createAiRound(config?, options?)` | 0 | returns `{ config, generateOpening, nextTurn, judge }`. `config` defaults to `loadEngineConfig()` (see section 8) |
| `ai.generateOpening(state, side, { timeoutMs?, signal? })` | 1 (0 if already stored) | one side's opening |
| `ai.nextTurn(state, { submissions?, turn?, speaker?, timeoutMs?, signal? })` | 1 (0 if already stored) | the next sequential turn, grouped audience included |
| `ai.judge(state, { timeoutMs?, signal? })` | 1 (0 if already judged) | the independent verdict |
| `parseRoundState(rawJsonOrObject)` | 0 | restores and validates a stored state, never throws |
| `serializeRound(state)` | 0 | `JSON.stringify` of the state (plain JSON, no Dates) |
| `publicRoundView(state)` | 0 | what the frontend may receive |

All model-backed functions return a discriminated result, **never throw**, and always return a `state`:

```ts
type OpeningStep = { ok: true;  state: AiRoundState; argument: PublicArgument; reused: boolean; telemetry?: CallTelemetry }
                 | { ok: false; state: AiRoundState; error: AiError };
type TurnStep    = { ok: true;  state: AiRoundState; argument: PublicArgument; reused: boolean; telemetry?: CallTelemetry;
                     private?: { audience; analysis?; briefing?; originalText? } }      // private = SERVER-ONLY
                 | { ok: false; state: AiRoundState; error: AiError };
type JudgeStep   = { ok: true;  state: AiRoundState; verdict: JudgeVerdict; complete: boolean; turnsCompleted: number; reused: boolean; telemetry? }
                 | { ok: false; state: AiRoundState; error: AiError };

type AudienceSubmission = { id: string; side: "A" | "B"; text: string; submittedAt: string | number; playerId: string };
type PublicArgument = { roundId; stage: "opening" | "turn"; sequence: number; debateTurn?: number; side: "A" | "B"; text: string; key: string };
type AiError = { code: "invalid_scenario" | "invalid_state" | "wrong_turn" | "out_of_order" | "not_ready" | "round_complete" | "round_closed" | "model_error";
                 message: string; retryable: boolean; modelCalled: boolean; modelErrorKind?: string; usage?: { inputTokens?: number; outputTokens?: number } };
```

`Scenario` is `{ title, description, evidence: string[], interpretationA, interpretationB }` (limits: title 200, description 2000,
1-20 evidence items of 400, interpretations 500 characters; the two interpretations must differ).

## 3. The round, step by step

Numbering: `sequence` is the position in the public transcript. **Opening A = 1, opening B = 2, then the eight debate turns are
sequence 3..10** (`debateTurn` 1..8). Speakers alternate A, B, A, B, A, B, A, B. The engine itself calls the first debate
turn "Turn 3".

| # | Call | Requests | Result stored in `state` |
|---|---|---|---|
| 0 | `startRound({ roundId, scenario })` | 0 | empty transcript, empty audience memory |
| 1-2 | `generateOpening(state, "A")`, `generateOpening(state, "B")` (any order; they do not read each other; they may run in parallel only if you merge both results yourself, so call them one after the other) | 1 each | opening in the transcript |
| 3-10 | `nextTurn(state, { submissions, turn })` x 8 | 1 each | turn appended, audience memory updated |
| 11 | `judge(state)` | 1 | verdict, `closed: true` |

A normal successful round is exactly **11 model requests** (2 + 8 + 1). Nothing else calls a model: grouping happens inside the
turn request, there is no scheduler and no background task.

Ready for judging: `publicRoundView(state).status === "ready_for_judge"` (all `maxTurns` turns done). `status` values:
`created`, `opening_in_progress`, `debating`, `ready_for_judge`, `judged`.

### Deadline (the 60-second AI budget)
The clock is yours. Pass `timeoutMs` to each call (for example the time left in the AI budget). When the deadline arrives before all
eight turns: stop calling `nextTurn` and call `judge(state)`. The engine judges whatever transcript exists as long as **both
openings** exist; the result has `complete: false` and `turnsCompleted: n`. The AI module does not forbid or hide this; whether to
pay out on an incomplete debate is your decision. A turn that is in flight when the deadline passes is not committed unless its
call returned `ok: true` (see 7).

## 4. Audience submissions

* **Format:** `{ id, side: "A" | "B", text, submittedAt, playerId }`. `id` is your unique submission id; `playerId` is **required** (it is the unit
  of support counting; a message without one counts only as an unattributed message, never as a supporter); `side` is the agent the
  player backs; `text` is cut to 200 characters and control/invisible characters are removed.
* **New or cumulative?** Either works because ids already in the state are ignored. **Simplest and recommended: pass the cumulative list of
  the round on every `nextTurn` call** (hundreds of items are fine). Only passing new ones also works, but if a call fails the submissions of
  that call are NOT stored (the state is returned unchanged), so you must resend them.
* **Eligibility:** everything you pass **to a call** is eligible for **that call's** request (state is updated first, then the briefing is built, then the
  request starts). A submission you receive while a request is running belongs to the next request of that side. Both sides' submissions you pass are
  stored; each agent's request sees only its own side's.
* **Duplicates:** the same `id` twice is ignored. Identical wording (case, punctuation and spacing ignored) by different players is one wording with
  several supporters. A **second submission by the same player** with different wording is stored but never counted (defensive only: you enforce
  one per player). The same player repeating a wording counts once.
* **Counts:** support is always the number of **distinct `playerId`s**, calculated in TypeScript (set unions, never sums of overlapping groups).
* **Semantic grouping** is done by the speaking agent inside its normal request and returned, validated, in `turn.private.analysis`. Invented ids,
  ids in two groups, ids both grouped and set aside, unrecognised classifications and omitted ids are quarantined or marked missing and never count as support.

What "audience" numbers mean (all server-side):

| Term | Meaning |
|---|---|
| received | in the state (`audience[side]`), after your `submissions` were ingested |
| included in the briefing | shown to that side's agent in this turn's prompt (`private.audience.includedIds`; the rest, if the 20,000-character budget overflows, is `queuedIds` and was **not** seen) |
| validated as support | in a validated relevant group (`private.analysis.accounting.validated`) |
| used in the argument | the agent's **self-report** (`group.usedInArgument`), unverified |

## 5. State: save, load, privacy

`AiRoundState` is one JSON document per round (store it as `jsonb`, keyed by `roundId`). Contents: version, `roundId`, `revision`, `maxTurns`, the
scenario, the **public** transcript, the verdict once judged, and `audience: { A, B }`, the private memory (message texts, player ids, wording counts,
which wordings were briefed when). It contains **no prompts, no API keys and no model internals**. Size: it grows with the audience (roughly tens to a
couple of hundred KB for 200 players; measure with your real data).

* **Server-only:** the whole state, `turn.private`, and `telemetry` (model, latency, tokens). Never send them to a browser; do not expose a route that returns the state.
* **Frontend-safe:** `publicRoundView(state)`, each `PublicArgument`, and `verdict` (it is built only from the public transcript).
* `parseRoundState` rejects: non-JSON, wrong version, bad scenario, a transcript out of order or with wrong numbering, an audience that belongs to another round or side,
  a verdict on an open round. **A missing row must be an error in your code**; do not call `startRound` again for an existing round.

The AI module has no Supabase dependency; you pass it the stored JSON and store what it returns.

## 6. Judge isolation

`judge` sends the model only: the public scenario (title, description, evidence), the two locked interpretations, and the public transcript. It never receives audience text,
supporter counts, grouping metadata, player ids, bets, balances, odds or agent memory (tests assert this on the actual prompt). The judge scores four dimensions
0-10 (evidence, logic, rebuttal, persuasion) per agent; the winner follows the declared rule (higher total; ties by rebuttal, then evidence); it must cite valid transcript ids
or the verdict is rejected as `invalid_output`. `verdict.overall` is computed in code.

## 7. Errors, retries, idempotency

Every failure returns `{ ok: false, state: <the input state, unchanged>, error }`.

| `error.code` | Meaning | `retryable` | Model request sent? | Backend action |
|---|---|---|---|---|
| `invalid_scenario` | bad input to `startRound` | no | no | fix the scenario upstream |
| `invalid_state` | stored state missing/corrupt/tampered | no | no | investigate; never recreate silently |
| `not_ready` | openings missing | no | no | generate openings first |
| `wrong_turn` / `out_of_order` | wrong speaker, or a sequence other than the next one | no | no | reload state; you are out of sync |
| `round_complete` | all turns done | no | no | call `judge` |
| `round_closed` | already judged | no | no | read the stored verdict |
| `model_error` | provider failure (`modelErrorKind`: `timeout`, `rate_limit`, `connection`, `provider_error`, `invalid_output`, `truncated`, `empty_output`, `auth`, `bad_request`, `refusal`, `config`) | `true` for the transient kinds | yes (except `config`) | retry the same call, or skip the turn if the clock ran out |

* **A retry after `model_error` is a NEW model request** (possibly billed again; failed requests report `error.usage` tokens when the provider returned them). A retry
  of a call that already **succeeded** (`reused: true`) is answered from the state and makes **no** request. The turn (`turn: n`) and judge calls are repeat-safe this way.
* **Not exactly-once:** if your function dies after the model answered but before you saved the state, the answer is lost and a retry calls the model again (a new, possibly different, speech).
  The module cannot prevent that.
* **Concurrent invocations:** two simultaneous calls on the same state would both call the model and produce two different speeches. Prevent it in the database:
  1. take a per-round lock (for example `UPDATE rounds SET locked_until = now() + interval '45 seconds' WHERE id = $1 AND (locked_until IS NULL OR locked_until < now()) RETURNING state`);
  2. call the AI function;
  3. save with compare-and-swap on the revision: `UPDATE rounds SET state = $new, revision = $newRev, locked_until = NULL WHERE id = $1 AND revision = $oldRev`. If 0 rows, discard the result and reload.
* **Idempotent keys:** argument keys are `roundId:opening:A|B`, `roundId:turn<sequence>:A|B` (`PublicArgument.key`) and the verdict key is `roundId:verdict`. Use them as unique
  constraints. **Do payouts only in the transaction where the verdict is first stored** (`closed` false -> true); a `reused: true` verdict must never trigger a second payout.
* Duplicate submissions are harmless (see 4).

## 8. Configuration

Defaults (`loadEngineConfig()` with nothing set): **Anthropic, `claude-sonnet-5-5` for Agent A, Agent B and the judge, effort `low`.** The benchmark harness (`claudeEngineConfig`) uses the same models and effort.

| Setting | Production default | Benchmark harness | Note |
|---|---|---|---|
| Agent / judge model, effort | sonnet-5-5 / sonnet-5-5, low | same | identical |
| Output cap, agents | **4096** tokens | 2500 | a cap, not a target: it only matters if the model's thinking plus reply exceed it. The live Sonnet benchmark ran with 2500 and completed without truncation. Recommendation: keep 4096 in production (it can only prevent truncation; behaviour is otherwise the same). To mirror the benchmark exactly set `AGENT_A_MAX_TOKENS=2500 AGENT_B_MAX_TOKENS=2500` |
| Output cap, judge | 2500 | 2500 | identical |
| Request timeout, agents / judge | 25 s / 40 s | 30 s / 45 s | always lowered further by the `timeoutMs` you pass per call |
| SDK retries (`AI_MAX_RETRIES`) | **1** | 0 | with 1, the Anthropic SDK may resend a request after a timeout/5xx, so a single call can bill twice and take longer. **Recommended for the game: `AI_MAX_RETRIES=0`** and retry explicitly |
| Judge parse retries (`AI_JUDGE_PARSE_RETRIES`) | 1 | 0 | with 1, an unparseable verdict triggers a second judge request (normal success is still 1) |

Environment variables (server-side only):

```
ANTHROPIC_API_KEY=...            # required. NEVER NEXT_PUBLIC_*, never sent to the browser
OPENROUTER_API_KEY=...           # only if a role uses provider=openrouter
# optional per-role overrides (provider anthropic|openrouter, model, effort low|medium|high, max tokens, timeout)
AGENT_A_MODEL=  AGENT_A_PROVIDER=  AGENT_A_EFFORT=  AGENT_A_MAX_TOKENS=  AGENT_A_TIMEOUT_MS=   (same for AGENT_B_*, JUDGE_*)
AI_MAX_RETRIES=0   AI_JUDGE_PARSE_RETRIES=1
```
A configured model is used exactly as given and is never silently replaced; an unknown or unavailable model comes back as a `model_error`.

## 9. Using it in a Vercel Node.js function

* Runtime: **Node.js** (`export const runtime = "nodejs"`), Node >= 20.12. Dependencies: `@anthropic-ai/sdk`, `openai` (only for OpenRouter), `zod`. Import it only from server code (route handlers, server actions).
* The module is TypeScript source (ESM, `moduleResolution: Bundler`). Import `ai/src/index` through a workspace path or alias and let Next transpile it (`transpilePackages` or a path alias to the folder).
* Set the route's `maxDuration` above the longest call you allow (an opening or a turn is a few seconds in practice; the judge up to its timeout).
* Check before deploying: `cd ai && npx tsc --noEmit && npm test`, and `npm run example:mock` (no key, no network).

### Minimal usage (one route per step, per round)

```ts
const row = await db.lockRound(roundId);                       // your lock (see 7)
const loaded = parseRoundState(row.state);
if (!loaded.ok) return fail(loaded.error);
const ai = createAiRound();                                    // production defaults
const step = await ai.nextTurn(loaded.state, { submissions: allSubmissionsOfThisRound, turn: loaded.state.transcript.length + 1, timeoutMs: msLeft });
if (!step.ok) return fail(step.error);                         // state unchanged: retry if step.error.retryable
await db.saveIfRevision(roundId, serializeRound(step.state), loaded.state.revision, step.state.revision);
return publicPart(step.argument);                              // NOT step.private, NOT step.state, NOT step.telemetry
```
A complete, runnable version with a mock model and an in-memory "database" is `examples/mock-round.ts` (`npm run example:mock`).

### Example payloads

`startRound` input -> `state.scenario` is stored as given. `generateOpening` -> `argument`:
`{ "roundId": "room-42:round-1", "stage": "opening", "sequence": 1, "side": "A", "text": "...", "key": "room-42:round-1:opening:A" }`.
`nextTurn` -> `argument`: `{ ..., "stage": "turn", "sequence": 3, "debateTurn": 1, "side": "A", "text": "...", "key": "room-42:round-1:turn3:A" }`
(every `text` is at most 45 words, enforced in code). `judge` -> `verdict`: `{ winner, explanation, summary, scores: { A: { evidence, logic, rebuttal, persuasion }, B: {...} }, overall, strengths, weaknesses, references, unsupportedAssumptions, decisiveExchange }`.

## 10. Not verified / open items

* Not run inside a Next.js build, on Vercel, or against Supabase; locking and compare-and-swap above are your implementation.
* The live benchmark (200 players, Sonnet 5.5, 11 requests, about 36 s) used `claudeEngineConfig`; production uses `loadEngineConfig` (differences in section 8).
* Semantic grouping quality is model-dependent; TypeScript guarantees consistent id accounting, not that every grouping is right. `usedInArgument` is a self-report.
* `playerId` must be a stable per-player id supplied by you; without it supporter counts are meaningless.
* The state grows with the audience; keep it in one row/column and avoid returning it to clients.
