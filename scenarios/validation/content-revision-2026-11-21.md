# Prepared cases, revision 2 (2026-11-21)

Answers `candidate-quality-review.md` (which stays as written, with `live-ranking-2026-11-21.txt`, for comparison). The previous
definitions are kept in `prepared-cases-v1.ts.txt`. No prompt, personality, selector, threshold or engine code was changed.
**Not yet validated live**: these edits are reasoned from the review and the first run's data, and checked only by mocked tests
(`test/case-quality.test.ts`, which encodes the author's evidence-to-reading map). The next live evaluation is the real test.

Rules followed: nothing resolves a case; every case keeps 4 interpretations with different causal mechanisms; at least two
readings per case have two or more supporting items; several items support one reading while weakening another; evidence is plain,
short and projector-readable.

## The Empty Display Case
| | Before | After |
|---|---|---|
| Evidence | conservator opened the case the previous afternoon; insurance renewal; smudged 1:45 log; no forced entry; alarm 2 a.m. | **removed** the conservator item (it handed `handling-error` a ready-made mechanism). **Added** "the case's door sensor logged an opening at 1:58 a.m., two minutes before the alarm" and "another gallery had asked to borrow the painting, but no collection date had been agreed". Kept alarm and quick response, intact glass and lock, smudged log, insurance valuation due |
| Readings | opportunistic-theft, staged-theft, handling-error, personal-motive-insider | `opportunistic-theft` **replaced by `outsider-opportunist`** (a visitor hidden after closing with a spare key), so it no longer duplicates the insider reading (both used to be "someone with access took it"). Others keep their ids; `handling-error` is now an *unlogged move for the pending loan* |

Why the alternatives are more defensible: the door-sensor opening and the quick response make a night-time unlogged move harder to hold, while the
loan request keeps it possible. The sensor entry two minutes before the alarm gives the staged reading a deliberate-timing argument, the outsider and insider
readings a "someone opened it" fact, and the smudged log supports an absent or distracted guard. The insurance item now stands beside other support instead of alone.

## The Silent Call
**Replaced** `wrong-number-loop` (a second technical explanation, same family as `equipment-fault`) with `person-in-difficulty` (someone who could not or dared not speak, dialling an old number): a human, benign cause. **Added** "a faint cough could be heard just before the line dropped" (a human-presence clue that equipment explains poorly; it supports the prank, intimidation and distress readings). Kept the payphone record, neighbours' calls, alarm panel replacement.
Why: the technical reading now stands alone and is weakened by the cough and by the neighbours' calls predating the panel work; the three human readings each have 2-3 supporting items.

## The Parked Van
**Replaced** `unrecorded-break` (almost the same as `personal-errand`: the driver steps away for their own reasons) with `late-added-stop` (legitimate work that never reached dispatch, repeated because nobody answered the day before). `personal-errand` now means a private visit, `off-book-handover` an illicit diversion of goods. **Added** "the depot's system lists two customers on that street, both with deliveries booked for later in the week" and "the maintenance sheet notes a warning light reported last week" (gives `breakdown-or-health` real support). Shortened to six items by merging the parking facts.
Why: the three driver-absence readings now differ in cause (private life, undeclared goods, unsystemised work) and in what would be found if checked.

## The Open Gate
**Removed** "shut again each evening" (it implied a person closes the gate and sank the latch reading) and the generic legitimate-visitor reading; `legitimate-visitor` **replaced by `arranged-collection`** (the family quietly arranged a pick-up or drop-off), which was overlapping the sitter reading (an authorised person forgetting to lock). **Added** "the gate's latch is old and sticks, and two mornings this week were very windy" and "a van parked briefly outside on Monday and Wednesday mornings".
Why: the latch reading is supported by the latch and wind items; the van supports scouting and the arranged collection and weakens the latch reading; the stranger on Tuesday supports scouting and weakens the latch and the pick-up.

## The Missing Rows
**Changed** the macro line: before, "the macro log shows no run" contradicted the automation reading; now the log "is only written when it finishes without error, and none was written", which fits a macro that failed part-way. **Added** "the forty deleted rows were one contiguous block" (fits a deliberate delete, a macro range or a mis-selected range) and a colleague who "may have tidied up the sheet on her new laptop" but has not confirmed it (supports the honest mistake and explains the new device). Moved the intact Friday backup to the description.
Why: the new-device sign-in no longer points mostly at an outside attacker; each of four readings (insider, outsider, macro, honest error) has three supporting items, and the colleague's remark weakens the insider and outsider readings without proving the mistake.

## The Drawn Curtains
**Softened** "exactly 6 p.m. and 6 a.m." to "about ... give or take a few minutes" (the exact timing made the timer almost proof) and made the hub ambiguous ("nobody knows which devices it controls"). **Added** "the tenant's car has not moved from its parking space all week" (supports hiding at home or a caretaker, and goes against nothing decisively). Kept mail collected (now "in the late morning") and the TV heard in the evenings. Sharpened the two "someone else" readings: `someone-else-living` is a guest *living* there, `caretaker-visits` is a visitor who *calls in* morning and evening.
Why: the mail and the TV weaken the timer on its own, the car and the silence support hiding, and the visitor/guest readings each have distinct supporting items.

## What the tests check
`test/case-quality.test.ts`: stable interpretation ids per case; at least two readings with two or more supporting items; the best-supported reading leads the runner-up by at most one item; no item points at one reading and against all the rest; at least two double-edged items and five or more evidence items per case; unique causal families and low word overlap (under 0.4) between readings; the specific fixes above; no verdict words in the evidence; public text length limits.
