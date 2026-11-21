# Candidate quality review of the six prepared scenarios

Status: **recommendations only. No prepared case was changed** (changing the cases to make a benchmark pass would hide the problem).
Evidence base: the first live run (6 Sonnet 5.5 rankings, see `live-ranking-2026-11-21.txt`) covers *The Empty Display Case* (4 rankings,
2 seeds) and *The Silent Call* (2 rankings). The other four cases have **no live data**; their notes come from reading the evidence against
the interpretations and are hypotheses to check in the next live evaluation.

## Where one interpretation dominates

| Case | Dominant reading | Why (evidence) | Live data |
|---|---|---|---|
| The Empty Display Case | `handling-error` | Evidence 5 ("a conservator had opened the case the previous afternoon") gives it a concrete, already-observed mechanism; intact glass and an unscratched lock fit it. Every theft reading needs an unobserved act. `staged-theft` rests on one item (the insurance renewal). | all 4 rankings put it first (scores 50-55); runner-up scores 32-48; staged-theft 18-35 |
| The Silent Call | `equipment-fault` and `wrong-number-loop` | The alarm company's panel test (evidence 5) and the dead payphone number point to a technical cause. These two are the same family ("a machine did it"), so the selected pair was two technical explanations that differ only in which machine. | A: 62 / 52; B: 62 / 58 for the same two readings |
| The Open Gate (reading only) | `sitter-routine` | "Shut again each evening" implies a person, which makes `faulty-latch` weak; `legitimate-visitor` overlaps with the sitter reading (someone with a key leaves it open). | none |
| The Missing Rows (reading only) | `account-compromised` / `insider-deletion` | A sign-in from a new device fits both; `automation-misfire` is undercut by "the macro log shows no run". | none |
| The Parked Van (reading only) | `personal-errand` ~ `unrecorded-break` | Both mean "the driver habitually steps away"; the repeat visit also weakens `breakdown-or-health`; "seal intact" weakens `off-book-handover`. | none |
| The Drawn Curtains (reading only) | `smart-timer` | Exact 6 p.m. / 6 a.m. timing plus the hub installed last month is strongly specific; the other three need extra assumptions. | none |

## Recommended improvements (not applied)

1. **Empty Display Case**: soften evidence 5 or make it cut both ways (for example "a conservator inspected the case two days earlier"), and add one
   observation each that a staged reading and an access-based theft can use (for example "the case sensor logged a door-open signal, not a glass break"; "the insurer had asked for a revaluation of this painting").
   Merge or sharpen `personal-motive-insider` and `opportunistic-theft`: both are "someone with access took it".
2. **Silent Call**: replace `wrong-number-loop` with a reading from a different family (for example a former acquaintance trying to reach her) or give prank/intimidation one more
   observation (for example "the ticking did not change in volume, as if from a separate source").
3. **Open Gate**: add an observation that does not imply a person closes the gate in the evening, or one that supports a visitor with a key versus the sitter.
4. **Missing Rows**: add an observation that makes automation plausible (for example "the macro only writes its log when it finishes without error").
5. **Parked Van**: separate `personal-errand` from `unrecorded-break` (a private errand versus a required rest) or replace one.
6. **Drawn Curtains**: soften the exactness or add one observation that weakens the hub (for example "the hub app showed no schedule for the curtains").

## What to measure next (the live evaluation prepared in `scripts/evaluate-live.ts`)

For every case: the first-choice distribution per interpretation across seeds (a reading chosen first in nearly every ranking is dominant),
the spread between the top two scores, and whether the two agents' selected pair come from different families of explanation.
