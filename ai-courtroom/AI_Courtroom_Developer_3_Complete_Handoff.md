# AI Courtroom — Complete Developer 3 Integration & Deployment Handoff

**Updated: 21 November 2026 | Audience: Developer 3 (Next.js / Supabase / Vercel owner)**

**Goal:** Connect both existing AI modules to the multiplayer game and deploy one playable global courtroom round. **Do not rebuild either AI subsystem.** This document replaces the earlier Developer 3 guide and the separate scenario-generation addendum.

## Ownership and source of truth

| Developer | Owns | Does not own |
|---|---|---|
| **Dev 1 — AI** | `ai/`: two debating agents, private audience briefing, persistent AI state, independent judge | Supabase, game phases, bets, UI, deployment |
| **Dev 2 — Scenarios / UI** | `scenarios/`: new case + evidence, image, independent opinions, blind checker, pair selection; player/projector UI | Backend state, storage upload, payout transactions, Vercel deployment |
| **Dev 3 — Backend / deployment** | Next.js API adapter, Supabase tables/storage/realtime, single global round, player identities, betting, submission acceptance, game clock, idempotent settlement, Vercel | Rewriting models, prompts, opinion checker or selector |

### Current integration status (verify in Git; do not assume newer work is merged)

- `ai/` is already merged into `master` at commit `31f6930`. Existing live AI test: **two openings + eight sequential turns + one independent judgment, ~36 seconds, ~US$0.13 estimated**, with 200 synthetic audience submissions. The previous handoff reported 228 passing tests at that point; run the current suite for the actual count.
- `scenarios/` initially pushed on **`feat/scenario-generation`** at commit `f891ed1`. **Subsequent scenario writer, OpenRouter image, `prepareNewRound`, checker fixes and benchmark changes were reported as uncommitted/unpushed** as of this handoff. Dev 2 must commit/push them before Dev 3 can use them; then merge the feature branch into `master` or coordinate a non-destructive branch merge.
- Latest scenario subsystem report: **149 mocked tests passing**, TypeScript clean; **one full live scenario+image+opinion-selection generation succeeded** in **17.422 seconds**, image **4.453 seconds**, Claude estimate **US$0.0403** plus OpenRouter-reported **US$0.03366325**. One successful live run is not an uptime guarantee.
- The **complete combined scenario → image → debate → 200 submissions → judgment benchmark** was proposed but **not yet reported as executed** in this handoff. Do not claim that the entire combined stack has passed until it does.

**The old `generatePair()`/parallel-debate architecture is obsolete.** The actual game requires **two sequential openings, eight sequential rebuttal turns, and one blind judge**. The six prepared cases are fallback fixtures, not the primary scenario source.

### Source files to read before coding

| File | What it defines |
|---|---|
| `scenarios/HANDOFF.md` | Scenario preparation and integration notes (especially **START HERE**) |
| `scenarios/src/index.ts` | Exported `prepareNewRound` entry point and types |
| `scenarios/src/prepare-new-round.ts` | Success/failure result variants, asset handling and retry semantics |
| `scenarios/src/image.ts` | Image bytes, type and OpenRouter integration |
| `ai/INTEGRATION.md` | Authoritative AI action and state contract |
| `ai/src/index.ts` | AI public exports and types |
| `ai/src/round.ts` | Actual round state-machine implementation |
| `ai/examples/mock-round.ts` | Known-working mocked lifecycle |
| `ai/test/integration.test.ts` | AI integration regression coverage |

**Use real exported TypeScript types rather than inventing any request, result or submission fields.** In particular, check `prepareNewRound`'s exact arguments, success discriminant and failure variants before implementing the adapter.

## Expected production flow

```text
Host requests / prefetches NEXT round
   -> [server, only once] scenarios.prepareNewRound(...)
         -> Claude generates fresh scenario and evidence
         -> OpenRouter creates image IN PARALLEL with:
              independent agents -> 6 opinions -> blind checker -> A/B selector
   -> persist completed scenario and PRIVATE metadata
   -> upload ImageAsset bytes to Supabase Storage; persist valid image URL/path
   -> [server, one global game] ai.startRound({ roundId, scenario, maxTurns: 8 })
   -> persist serialised AI state
   -> reveal public scenario, image and locked opinions
   -> accept authenticated bets and one eligible suggestion per player
   -> opening A -> save -> opening B -> save
   -> 8 sequential debate turns, latest eligible submissions -> save each
   -> blind judge PUBLIC scenario/evidence/locked opinions/transcript only
   -> save verdict -> reveal -> settle tokens exactly once -> leaderboard
```

**Latency plan:** Prepare before the round timer starts. Optionally prefetch the next round while the current debate runs, using a *durable, deduplicated server-side job/request and database persistence*; do not rely on Vercel instance memory or an unawaited background promise. Last observed preparation ~17.4 s and separate debate+judgment ~36 s, i.e. ~53.4 s if run consecutively (not an SLA). Typical successful full run uses **15 Claude calls + 1 OpenRouter image call**: 4 Claude and 1 image for preparation; 11 Claude for debate/judge. Earlier separate cost observations imply roughly **US$0.20** total, but actual usage, pricing, retries and failures vary.

---

## Step 1 — Merge the AI implementation into your backend branch

From the repository root:

```
git status
git fetch origin
git switch feat/backend-multiplayer-connection
git merge origin/master
```

If the branch is not yet available locally:

```
git switch --track origin/feat/backend-multiplayer-connection
git merge origin/master
```

Resolve any conflicts before continuing. Do not reset the backend branch or overwrite existing backend changes.

**Scenario branch prerequisite:** Before integrating `scenarios/`, confirm Dev 2 has pushed the *latest* changes (including `prepareNewRound` and the checker fix). Ideally merge `feat/scenario-generation` into `master`, then merge updated `origin/master` into the backend branch. If the team chooses direct feature-branch integration under the deadline, fetch and merge that branch explicitly after coordination; do not assume the earlier `f891ed1` push includes the full image pipeline. Resolve conflicts without overwriting anybody's work.

Confirm the AI files exist:

```
ls ai/src/round.ts
ls ai/INTEGRATION.md
ls ai/examples/mock-round.ts
ls scenarios/src/prepare-new-round.ts
ls scenarios/HANDOFF.md
```

## Step 2 — Verify the AI subsystem independently

```
cd ai
npm ci
npx tsc --noEmit
npm test
npm run example:mock
```

Expected:

- TypeScript compilation succeeds.
- All existing AI tests pass.
- The mock runs two openings, eight sequential turns and one judgment.
- State is saved and restored between steps.
- Exactly 11 mocked model requests are made.

This test must succeed before connecting Supabase.

Also verify the scenario module **after the latest branch has been integrated**:

```bash
cd ../scenarios
npm ci
npx tsc --noEmit
npm test
npx tsx scripts/benchmark-full-generation.ts  # dry-run only: no paid requests
```

Do **not** use `--approved` on a shared/deployed system without explicit approval. The existing full-generation benchmark writes local output to its ignored `output/` directory; production must use Supabase Storage and durable persistence instead.

Return to the repository root afterward.

## Step 3 — Read the actual integration contract

Read these files in order:

1. `ai/INTEGRATION.md`
2. `ai/src/index.ts`
3. `ai/src/round.ts`
4. `ai/examples/mock-round.ts`
5. `scenarios/HANDOFF.md`
6. `scenarios/src/index.ts` and `scenarios/src/prepare-new-round.ts`

The **AI debate** public API is:

```
startRound({ roundId, scenario, maxTurns? })

createAiRound(config?, options?)

ai.generateOpening(state, side, {
  timeoutMs?,
  signal?
})

ai.nextTurn(state, {
  submissions?,
  turn?,
  speaker?,
  timeoutMs?,
  signal?
})

ai.judge(state, {
  timeoutMs?,
  signal?
})

parseRoundState(...)
serializeRound(...)
publicRoundView(...)
```

Use the exported types for exact payload definitions:

- `AiRoundState`
- `AudienceSubmission`
- `AiError`
- `PublicArgument`
- `OpeningStep`
- `TurnStep`
- `JudgeStep`
- `PublicRoundView`

Do not introduce replacement versions of the AI state or response schema.

The **scenario-generation** entry point is `prepareNewRound` (see the actual export for its exact argument and return types). On success, the reported contract includes:

| Result field | Meaning | Visibility |
|---|---|---|
| `scenario` | Locked, validated input for `startRound` | Server, with only public fields projected |
| `publicCase` | Public title, setting, description, evidence and JSON-safe image metadata | Player/projector after appropriate phase |
| `image` | `ImageAsset`: actual bytes, MIME type, filename, SHA-256 | Server only until uploaded |
| `server` | Hidden designs, personalities, all six opinions, checker reports, costs and diagnostics | **Server only; never clients or judge** |

**Do not create a URL for the generated image until upload actually succeeds.** A fallback may explicitly have `image: null` / `imageStatus: "fallback_without_image"`. Do not claim every case has an image.

## Step 4 — Configure the AI provider

In the Next.js application's server-side environment, configure:

```
ANTHROPIC_API_KEY=actual_key
OPENROUTER_API_KEY=actual_openrouter_key
OPENROUTER_IMAGE_MODEL=google/gemini-3.1-flash-lite-image

AI_MAX_RETRIES=0
AI_JUDGE_PARSE_RETRIES=0
```

Keep the existing defaults:

| Role             | Model               |
| ---------------- | ------------------- |
| Agent A          | `claude-sonnet-5-5` |
| Agent B          | `claude-sonnet-5-5` |
| Judge            | `claude-sonnet-5-5` |
| Reasoning effort | Low                 |

The production agent output cap is 4,096 tokens. Keep it unless a real integration test identifies a problem.

Configure the existing Supabase environment variables according to the backend's implementation. Public URL/publishable credentials may be client-accessible; service-role credentials and Anthropic keys must be server-only.

**Never use `NEXT_PUBLIC_` for Anthropic or OpenRouter API keys, Supabase service-role keys, or hidden scenario metadata.**

Add the same required server-side variables in Vercel's Environment Variables settings.

## Step 5 — Connect the AI module to Next.js

Create a server-only adapter in Developer 3's backend code, using the existing source exports.

For example:

```
import {
  startRound,
  createAiRound,
  parseRoundState,
  serializeRound,
  publicRoundView
} from "<path-to-ai>/src/index";

const ai = createAiRound();
// Import prepareNewRound from scenarios/src/index.ts using the actual exported signature.
```

Replace the import path with the correct workspace-relative path.

If Next.js cannot compile the linked TypeScript module, configure the appropriate workspace import or `transpilePackages` entry. Verify with a production build.

Use Node.js runtime for server routes that call the Anthropic SDK:

```
export const runtime = "nodejs";
```

Set each route's supported `maxDuration` according to its expected model request duration and actual Vercel deployment limits.

**Do not run preparation + all 11 debate/judge calls inside one giant serverless invocation.** Each completed AI action should be committed to the database. A scenario-preparation operation may itself take ~17 seconds; check Vercel's supported max execution duration and use a separately triggered server route/job. The model SDK and OpenRouter call must execute server-side in Node.js.

## Step 6 — Store AI round state in Supabase

The AI module returns a serialisable state snapshot. Store one complete snapshot per round.

A minimal persistence design needs:

| Field        | Purpose                                 |
| ------------ | --------------------------------------- |
| `round_id`   | Unique round identifier                 |
| `state`      | Complete AI state as JSONB              |
| `revision`   | Concurrency version                     |
| `status`     | Current processing or completion status |
| `updated_at` | Last committed update                   |

The backend may already have equivalent tables. Reuse them.

Store audience submissions separately, including their stable player identifiers, so new submissions cannot disappear while a model request is running.

Store **prepared cases separately** from active-round state, reusing existing tables where possible. Minimum useful fields: unique `prepared_case_id`, `status` (`preparing` / `ready` / `failed` / `used`), `scenario` JSON, `public_case` JSON, `image_storage_path` or valid URL, and timestamps. Keep private diagnostics in a restricted server-only record if retained at all. Make preparation idempotent per intended upcoming round so duplicate host clicks do not generate multiple charged cases. Upload images to Supabase Storage using their supplied bytes and MIME type, record the successful object path/URL, and clean up orphan uploads on failure where feasible. Public or short-lived signed URLs are both viable for synthetic public cases; if signed, refresh when necessary. **Do not put image bytes in JSONB or send them to clients via round-state API.**

On every AI action:

1. Load the current state and revision.
2. Acquire a per-round processing lease or equivalent exclusive claim.
3. Restore the state using `parseRoundState`.
4. Call the requested AI function.
5. If successful, save `serializeRound(step.state)`.
6. Update the revision atomically using compare-and-swap.
7. Release the processing claim and publish the new public state.

The database update must succeed only when the expected revision and processing owner still match. Use an atomic conditional update or Supabase RPC.

Do not hold an ordinary database transaction open throughout a slow external LLM request.

**Critical:** Two simultaneous `run-ai` calls must not produce and publish competing speeches.

## Step 7 — Prepare a brand-new illustrated scenario, upload it, then start the round

**This replaces the old assumption that Dev 2 supplies a static scenario manually.** Dev 2 supplies a working *generator module*, and Dev 3 calls it from the server before each new round.

1. **Acquire a unique preparation claim** for the next round and choose a seed / recent-title exclusions if supported by the exported API. Do not begin the live 90–120-second round timer yet.
2. **Call `prepareNewRound(...)`** using its actual typed signature and server-side environment. Normal path generates a new case and evidence in one Claude request, then a real image and independent opinion pipeline in parallel; two agents independently produce three opinions each, a blind third checker scores all six, and a deterministic selector locks two meaningful A/B views.
3. **Handle the typed result:** if successful, use the returned `scenario` *unchanged* as the AI engine input. If failure, preserve the stage/error, and follow the chosen backend retry/fallback/cancel policy. Do not independently call the opinion generator or rewrite the locked viewpoints.
4. **Upload the image** from `image.bytes`/MIME type/filename to Supabase Storage, record its actual object location and public/signed URL in the player's public case view. Verify upload success. Keep image bytes and metadata distinct from the serialised AI state. A generated image must match visible evidence without leaking private designed explanations; human-check one before the demo.
5. **Persist the completed prepared case** and mark it `ready` only when the scenario, selected positions and required image (or explicitly permitted imageless fallback) are available. Keep `server` and hidden scenario-design data private.
6. **Start the global round once** with the exported AI API:

```ts
const state = startRound({
  roundId,
  scenario: prepared.scenario, // exact validated object returned by prepareNewRound
  maxTurns: 8
});
```

7. **Persist initial AI state and publish public case data** to clients. Lock both interpretations for the lifetime of the round. The image URL is application metadata to publish alongside `publicRoundView`, not a reason to modify the AI state schema.
8. **Only then start betting/debate phases and their timers.** Reuse a previously prepared `ready` case if a second host request arrives; never charge twice or start two competing games.

**Prefetch recommendation:** While round N is debating, call preparation for N+1 through a durable server-side process and save its result. This can make player-visible preparation delay near zero if it finishes in time. If preparation is still running, show a waiting/preparing phase rather than starting a round without its image/opinions.

**Fallback:** The six existing example cases are fixtures; the scenario module can optionally return a prepared fallback without an image. Decide explicitly whether that is acceptable for the demo. Do not claim that a fallback image exists, and do not silently change the locked interpretations mid-round.

**Provider budget:** A successful preparation usually uses **4 Claude calls + 1 OpenRouter image call**. Its earlier full live timing was **17.422 seconds**. Image generation took ~4.45 seconds in parallel with opinions. Generation can fail and any retry costs extra requests. No strict production latency guarantee follows from a single sample.

## Step 8 — Generate the openings

When the backend enters the debate phase:

```
const a = await ai.generateOpening(
  state,
  "A",
  { timeoutMs }
);
```

Check `a.ok`. If successful, persist `a.state` and publish Agent A's public speech.

Then use the newly persisted state for Agent B:

```
const b = await ai.generateOpening(
  updatedState,
  "B",
  { timeoutMs }
);
```

Check, persist and publish again.

Do not generate both openings concurrently against the same mutable state unless you explicitly implement a correct merge strategy. Sequential execution is already supported and tested.

Each opening is one LLM request.

## Step 9 — Receive audience suggestions

The backend owns participant identity, betting eligibility and submission acceptance.

For every audience message:

- Obtain `playerId` from the authenticated server session, not from a freely editable client field.
- Derive its side from the player's confirmed bet or supporter assignment.
- Validate that the appropriate submission phase is open.
- Enforce one accepted submission per player per round.
- Store the message and its stable identity.
- Reject duplicates and submissions after the deadline.

Use the exact `AudienceSubmission` type.

The AI needs stable IDs to determine how many distinct people support equivalent suggestions.

**Do not filter submissions down to the top three.** The new AI design processes cumulative collective audience recommendations.

When generating a turn, pass the eligible submissions in the format expected by the integration API. The existing AI module handles exact wording aggregation, semantic grouping and counting.

There is no separate semantic grouping LLM call.

If a large audience exceeds the 10,000-character briefing budget, messages must remain stored even if not all can fit in one turn. Preserve the distinction between received and actually briefed submissions.

## Step 10 — Run eight sequential debate turns

After the two openings, the expected sequence is:

| Transcript turn | Speaker |
| --------------- | ------- |
| 3               | Agent A |
| 4               | Agent B |
| 5               | Agent A |
| 6               | Agent B |
| 7               | Agent A |
| 8               | Agent B |
| 9               | Agent A |
| 10              | Agent B |

For each turn, the backend should:

1. Load the latest persisted AI state.
2. Query all eligible audience submissions for the round.
3. Determine the next speaker and turn number from the stored state.
4. Call `ai.nextTurn`.
5. Check whether the result succeeded.
6. Persist the updated state before broadcasting the speech.
7. Publish the public argument for the frontend.
8. Move to the next turn only when permitted by the round clock.

Conceptually:

```
const loaded = parseRoundState(row.state);

const step = await ai.nextTurn(loaded.state, {
  submissions: allRoundSubmissions,
  turn: loaded.state.transcript.length + 1,
  timeoutMs
});

if (step.ok) {
  await saveStateAtomically(
    serializeRound(step.state),
    loaded.state.revision,
    step.state.revision
  );
}
```

Use your actual persistence function and the exported interfaces.

The game backend controls the clock. The AI module controls argument generation and validation.

**The eight turns are sequential**, because each agent responds to the preceding public argument.

The normal total is:

- Two opening requests.
- Eight debate requests.
- One independent judging request.

**11 LLM requests.**

## Step 11 — Apply the timing budget

The separate AI benchmark completed the eight debate turns and openings in approximately 30 seconds, with another approximately 6 seconds for judging. The separate successful scenario+image preparation benchmark took 17.422 seconds. **If preparation is not prefetched, planning baseline is ~53 seconds total AI time** before backend/network overhead. These are separate benchmark measurements, not a combined measured end-to-end run.

However, this is measured performance, not a guaranteed latency.

Store absolute server-side deadlines for the debate and judgment phases.

Before starting another turn, check the remaining time. The AI API supports per-call timeouts and abort signals.

If the debate budget expires before all eight turns complete:

- Stop requesting additional debate turns.
- Preserve all completed public arguments.
- Mark the debate incomplete.
- Proceed to judging if both openings have completed and the round policy permits it.

The existing judge supports partial debates. It returns an incomplete status and number of turns played.

If either opening is missing, follow the documented error or cancellation path rather than pretending a full debate occurred.

## Step 12 — Call the independent judge

After the debate ends:

```
const result = await ai.judge(state, {
  timeoutMs
});
```

Check `result.ok`, persist the updated state, then use the public verdict fields for the game.

The judge must only see the public scenario, locked interpretations and public transcript.

Never pass it:

- Private audience suggestions.
- Grouping metadata or supporter counts.
- Player IDs.
- Bets or balances.
- Betting odds.
- Hidden agent state.
- Scenario-generation private designs, personalities, checker grades or pair-selection diagnostics.

The AI subsystem already enforces this isolation. The backend must not bypass it.

The judge produces the winner, four scoring dimensions and the explanation. Do not replace its scoring with a count of supporters or bettors.

## Step 13 — Reveal the verdict and settle bets

Developer 3 owns this entire step.

Only after a valid judgment is persisted:

1. Transition the game into the verdict-reveal phase.
2. Publish the winner and explanation.
3. Settle all eligible bets through the existing transactional settlement logic.
4. Update virtual-token balances and leaderboard.
5. Mark settlement complete so it cannot run again.

The settlement must be idempotent. A duplicated request, refresh or admin click must never pay players twice.

If the round is cancelled, follow the backend's existing refund policy and make refunds idempotent as well.

## Step 14 — Expose only public state

Return the AI's public representation using:

```
publicRoundView(state)
```

The frontend may receive the scenario, public evidence, valid uploaded image URL, two locked public interpretations, public arguments, public progress and revealed verdict, subject to the game phase. If a signed image URL expires, handle refresh without exposing backend credentials.

Never send `AiRoundState` directly to clients.

It contains both agents' private audience messages, player identifiers and grouping bookkeeping.

For realtime updates, send minimal public events. Clients should fetch the authoritative server state after reconnecting or receiving an event with a newer version.

## Step 15 — Handle errors and retries

The model-backed integration API returns a structured result containing `ok`, state and error information rather than throwing for handled AI failures.

Handle failures according to `AiError`, including `retryable` and `modelCalled`.

| Situation                           | Backend behaviour                                         |
| ----------------------------------- | --------------------------------------------------------- |
| Preparation called twice             | Reuse existing `ready` or `preparing` case                |
| Scenario generation/checker failed   | Keep game in `preparing`, use explicit retry/fallback/cancel policy |
| Image generation or upload failed    | Do not reveal fabricated image; recover or use declared imageless fallback |
| Duplicate completed turn            | Reuse stored result                                       |
| Concurrent turn requests            | Only one may acquire the processing claim                 |
| Provider timeout                    | Preserve last committed state; retry only if time permits |
| Invalid model output                | Keep previous state and handle the returned error         |
| Server crashes after model response | Retry may incur another model call                        |
| Incomplete debate                   | Judge partial transcript when allowed                     |
| Invalid judge verdict               | Controlled retry or cancel/refund                         |
| Duplicate settlement                | Return existing settlement, never pay again               |

Do not assume exactly-once LLM execution. The database can guarantee one committed turn, but a crashed request may still have incurred an API charge.

## Step 16 — Connect Developer 2's frontend

Agree on the frontend-facing state contract.

The player interface needs:

- Newly generated public scenario and evidence, valid uploaded image URL or clear imageless-fallback state.
- Both competing interpretations.
- Betting status.
- Audience submission status.
- Public debate transcript.
- Judge progress and final verdict.
- Token balance and leaderboard.

The projector interface needs the public image and evidence, both locked views, the public arguments in speaking order and the final verdict.

If the frontend was built against the older parallel-debate architecture, adapt the backend response to the new sequential transcript. Do not rewrite the AI engine to imitate the older architecture.

## Step 17 — Test the complete system

Run these tests in this order.

**A. Mock multiplayer round (both modules)**

Use fake scenario/image/AI providers first. Check one prepared case, image-upload adapter, joining, betting, suggestions, public arguments, judging, settlement and leaderboard. Validate that startRound receives the real `prepareNewRound` result shape. The standalone AI mock makes 11 model calls; the standalone scenario mocked tests cover generation and checking.

**B. Persistence test**

Save and restore after every single AI action. Refresh the browser during the debate. Confirm the transcript and audience state remain intact.

**C. Concurrency test**

Trigger two simultaneous requests for the same next turn. Confirm only one new turn is committed and only one result is visible.

**D. Privacy test**

Inspect the `/api/state` response and realtime messages. Confirm neither contains private prompts, audience messages, raw AI state, API keys, private designs, personalities, checker judgments, image binary bytes or server-only metadata. Only server-generated public case and storage URL should appear.

**E. Failure test**

Simulate duplicate preparation, scenario/checker failure, image-generation failure, failed Supabase Storage upload, expired image URL, provider timeout, invalid output and failed state save. Check recovery, cancellation and refund behaviour. Validate fallback-without-image UI if the policy permits it.

**F. Live end-to-end AI test**

Use real Sonnet and OpenRouter to produce a **new image-backed scenario**, lock two distinct interpretations, complete two openings plus eight sequential turns, and judge the public transcript. Test with 200 unique synthetic participants (e.g. 100 per side) if the benchmark is available. Check actual timing, request count, image consistency, provider errors, public argument length (≤45 words), private-data isolation, verdict and estimated cost. **This AI simulation does not simulate 200 simultaneous browsers or verify Supabase network concurrency**; test those separately. The last scenario-only live test succeeded; a full combined live run is not yet confirmed.

**G. Multi-browser test**

Test with several independent sessions, including a separate projector. Confirm all clients see the same speaker, round and final balances.

**H. Production build and deployment**

From the Next.js application root:

```
npm run build
```

Fix any workspace import, Node.js runtime or TypeScript integration issues.

Deploy to Vercel and run at least one complete round against the deployed Supabase project. Ensure **both** API keys are server-only Vercel environment variables, confirm `OPENROUTER_IMAGE_MODEL`, and check deployment duration limitations for scenario preparation and each AI turn. Verify that public Storage asset URLs actually load in both player and projector clients.

## Step 18 — Final demo readiness

Before the hackathon presentation, verify:

- One global game can be started and reset by the host.
- Each new round is prepared from the live scenario module (or explicitly declared fallback), with a genuinely uploaded image, before the timer starts.
- Both AI interpretations are locked before the debate.
- Players can join, bet and submit their suggestions.
- The backend enforces correct supporter identities and submission deadlines.
- Both openings and all eight turns can appear in order.
- The judge is independent of betting and audience coaching.
- A verdict correctly triggers settlement exactly once.
- Refreshing any player or projector screen restores the game.
- A timed-out debate can be judged or cancelled safely.
- The Vercel deployment has both Anthropic and OpenRouter server-side secrets and the required Storage credentials.
- Duplicate scenario preparation does not charge for or publish multiple cases.
- Private scenario designs and checker reports never reach clients or judge.
- An approved backup scenario and mock-output fallback are available if live inference fails.

## Final handoff rule

**Developer 1's AI implementation and Developer 2's scenario/opinion algorithms should remain unchanged unless integration identifies a reproducible bug.**

Developer 3 should own the adapter, route handlers, persistence, concurrency, game clock, realtime events, authentication and financial-game logic.

Developer 2 should own scenario and image generation, the independent opinion/checker/selector pipeline, scenario validation and the frontend. **Developer 3 owns the actual Storage upload and published image URL.**

The goal is a reliable end-to-end demonstration, not another AI architecture redesign.

## **The three most important priorities**

If Developer 3 is short on time, prioritise **getting the latest `scenarios/` branch integrated; mock end-to-end integration; atomic state persistence; one live deployed round**, in that order. Do not prioritise more prompt tuning or benchmark optimisation over a playable deployment.

The main potential blocker is not Sonnet's reasoning speed. It is coordinating the Supabase state updates and the timed API requests without duplicate turns, lost audience submissions or premature judgments.

Once those three pieces work, the system has a viable complete demo.

---

## Minimal Dev 3 handoff / acceptance checklist

- [ ] Latest `scenarios/` changes committed/pushed and integrated without overwriting backend work.
- [ ] Both packages install, compile and pass mocked tests.
- [ ] Real `prepareNewRound` success result accepted by backend using exported types.
- [ ] Image bytes uploaded, valid public/signed Storage URL visible in clients; no fabricated image URL.
- [ ] Scenario/evidence and A/B opinions persisted, not regenerated mid-round.
- [ ] One global server-side round started with `startRound({ roundId, scenario, maxTurns: 8 })`.
- [ ] Each action serialised/restored atomically; duplicate worker/host requests safely deduplicated.
- [ ] Authenticated one-submission-per-player policy and betting-side assignment enforced.
- [ ] Two sequential openings, eight sequential debate turns, and blind independent judgment execute.
- [ ] `publicRoundView` plus explicitly public case/image data only; no private supporter data or hidden designs.
- [ ] Verdict persisted before idempotent payout; refund/cancellation works.
- [ ] Vercel + Supabase production build works, secrets remain server-only, player + projector see a live complete round.

**If the clock is tight:** a deployed end-to-end round with a known-good cached/prepared case is more valuable than an unintegrated generator. Preserve the live generation route, but have an explicitly labeled fallback available for the demo.
