import type { ScenarioCase } from "./types";

/**
 * Hand-authored, validated cases (ready to use without any model call). Revision 2 (see validation/content-revision-2026-11-21.md;
 * the first version is kept in validation/prepared-cases-v1.ts.txt). The evidence supports several readings and settles none:
 * at least two interpretations have real support in every case, each interpretation has a different causal mechanism, and several
 * observations cut both ways, which is what an eight-turn debate needs. Interpretation ids are stable; an id whose meaning changed
 * materially was replaced by a new id. Generate more with generateScenarioBatch (live, separate step) and validate them with
 * validateScenarioCase before adding them to a pool. `imagePath` is left unset: images are generated separately.
 */
export const PREPARED_CASES: ScenarioCase[] = [
  {
    id: "empty-display-case",
    title: "The Empty Display Case",
    description: "At 2 a.m. a museum alarm sounded. Staff reached the gallery within minutes and found the display case of a minor painting open and empty. Nothing else in the gallery had been disturbed.",
    evidence: [
      "The alarm sounded at 2 a.m. and staff reached the gallery within four minutes.",
      "The display case was open and empty; the glass was intact and the lock showed no scratches.",
      "The case's door sensor logged an opening at 1:58 a.m., two minutes before the alarm.",
      "The night guard's logbook has a partly smudged entry for 1:45 a.m.",
      "The painting's insurance valuation was due for renewal that week.",
      "Another gallery had asked to borrow the painting, but no collection date had been agreed.",
    ],
    interpretations: [
      { id: "outsider-opportunist", label: "Outsider on impulse", description: "A visitor who stayed hidden after closing got hold of a spare or left-behind key, opened the case on impulse and set off the alarm while slipping out." },
      { id: "staged-theft", label: "Staged for insurance", description: "The theft was planned to support a later insurance claim: someone opened the case, removed the painting and deliberately triggered the alarm to leave an official record." },
      { id: "handling-error", label: "Unlogged loan move", description: "No theft happened: the painting was taken out for the pending loan by someone who did not log it, and the alarm was tripped by accident during the move." },
      { id: "personal-motive-insider", label: "Insider, private motive", description: "A staff member took the painting for private reasons such as sentiment or a private sale, using their own key and the guard's routine, with no link to insurance." },
    ],
    imagePrompt: "A dim museum gallery at night, an open empty glass display case under a single spotlight, a security camera in the corner, moody cinematic lighting, no people, painterly realism.",
  },
  {
    id: "silent-call",
    title: "The Silent Call",
    description: "A woman's landline rang at 3 a.m. When she answered she heard only faint breathing and a ticking sound before the line went dead. Nothing like it had happened to her before.",
    evidence: [
      "The call came at 3:02 a.m. and she answered on the second ring.",
      "She heard faint breathing and a steady ticking; nobody spoke, and the line dropped after about twenty seconds.",
      "A faint cough could be heard just before the line dropped.",
      "The phone records show the calling number belongs to a payphone that was removed last year.",
      "Two neighbours say they received a similar late-night call last month; none since.",
      "Her home alarm company replaced its control panel last week and tested the panel's dial-out line.",
    ],
    interpretations: [
      { id: "prank-call", label: "Prank call", description: "A local teenager using a number-spoofing app made the call for fun and played a ticking clock to unsettle her." },
      { id: "equipment-fault", label: "Equipment fault", description: "A faulty or misconfigured device, such as the new alarm panel or a legacy exchange line, dialled by mistake and produced the noises as line artefacts." },
      { id: "targeted-intimidation", label: "Targeted intimidation", description: "Someone is deliberately frightening her, hiding behind a dead number, and the earlier calls to neighbours were rehearsals or cover." },
      { id: "person-in-difficulty", label: "Someone who could not speak", description: "A person who could not or dared not speak, such as someone in trouble or a child on a borrowed phone, dialled her number hoping to reach a previous owner of it." },
    ],
    imagePrompt: "A dark bedroom at 3 a.m., a ringing old landline telephone on a nightstand, a clock face showing 3:02, thin light from a streetlamp through the blinds, tense atmosphere, no faces.",
  },
  {
    id: "open-gate",
    title: "The Open Gate",
    description: "A neighbour's front gate, normally kept locked, has been found open every morning this week. The family is on holiday and arranged a house-sitter whom none of the neighbours has met.",
    evidence: [
      "The usually locked front gate was found open every morning this week.",
      "The lock is undamaged and nothing visible has been taken from the garden.",
      "The family is away and arranged a house-sitter whom no neighbour has met.",
      "A neighbour saw an unfamiliar person standing near the gate on Tuesday afternoon.",
      "The gate's latch is old and sticks, and two mornings this week were very windy.",
      "One neighbour says a van parked briefly outside on Monday and Wednesday mornings.",
    ],
    interpretations: [
      { id: "sitter-routine", label: "House-sitter's routine", description: "The house-sitter leaves early and forgets to relock the gate behind them, then closes it again later in the day." },
      { id: "scouting-visits", label: "Someone scouting", description: "A stranger is checking whether the house is watched, opening the gate each morning to see who reacts." },
      { id: "faulty-latch", label: "Latch fails in the wind", description: "The gate was never properly locked: the worn latch does not engage, and wind or the gate's own weight swings it open overnight." },
      { id: "arranged-collection", label: "Pre-arranged pick-up", description: "The family arranged for a relative or tradesperson to collect or drop off items while they are away and left the gate unlocked for them, without telling the neighbours." },
    ],
    imagePrompt: "A quiet suburban street at dawn, a wrought-iron front gate standing slightly open on a tidy garden path, long soft shadows, mist, a hint of unease, no people visible.",
  },
  {
    id: "missing-rows",
    title: "The Missing Rows",
    description: "On Monday morning an accountant found forty rows missing from a shared spreadsheet. A backup from Friday is intact, so nothing is lost for good, but nobody knows how the rows disappeared.",
    evidence: [
      "Forty rows were missing on Monday morning; the file history shows the deletion at 11:52 p.m. on Sunday.",
      "The deletion was made under a shared analyst login that rarely edits this file.",
      "That login signed in on Sunday evening from a device the system had not seen before.",
      "A data-cleaning macro is scheduled for Sunday nights; its log is only written when it finishes without error, and none was written.",
      "The forty deleted rows were one contiguous block.",
      "A colleague says she may have tidied up the sheet on her new laptop over the weekend, but she has not confirmed it.",
    ],
    interpretations: [
      { id: "insider-deletion", label: "Deliberate insider deletion", description: "A colleague with access to the shared login removed the rows on purpose, for example to hide figures, and chose a quiet hour to do it." },
      { id: "account-compromised", label: "Compromised login", description: "An outsider obtained the shared credentials, signed in from their own device and deleted the rows, possibly to cause disruption." },
      { id: "automation-misfire", label: "Macro misfire", description: "The scheduled cleaning macro started under that login, failed part-way and wrongly removed a block of rows before crashing without writing its log." },
      { id: "honest-mistake", label: "Honest mistake", description: "A colleague working late on a new laptop selected and deleted the wrong range by accident, never noticed, and has not reported it." },
    ],
    imagePrompt: "A dark open-plan office at night, a single monitor glowing with a spreadsheet that has an obvious gap in its rows, a cold blue light, empty desks, no people.",
  },
  {
    id: "parked-van",
    title: "The Parked Van",
    description: "A delivery van sat for forty minutes on a quiet side street two roads away from its scheduled route. The driver was not with it, and the cargo door was shut.",
    evidence: [
      "The van was parked for forty minutes on a side street two roads from its route, with the driver absent, the cargo door shut and the engine off.",
      "A shop owner says the same van parked in the same spot the day before.",
      "Dispatch received no call from the driver, and the GPS log shows normal pings before and after the stop.",
      "The cargo seal was recorded as intact at the end of the shift.",
      "The depot's system lists two customers on that street, both with deliveries booked for later in the week.",
      "The van's maintenance sheet notes a warning light reported last week.",
    ],
    interpretations: [
      { id: "personal-errand", label: "Private visit", description: "The driver is visiting someone nearby for private reasons, a regular personal stop unrelated to any delivery, and leaves the van while doing so." },
      { id: "off-book-handover", label: "Unlogged handover", description: "The driver meets someone at that spot to hand over or collect goods outside the company's records, then reseals the cargo." },
      { id: "late-added-stop", label: "Late-added customer stop", description: "The driver is serving a customer on that street whose delivery was added late and never reached the dispatch system, and came back because nobody answered the day before." },
      { id: "breakdown-or-health", label: "Breakdown or health issue", description: "The van or the driver had a brief problem, a warning light or a health need, and the driver went for help without calling in." },
    ],
    imagePrompt: "A white delivery van parked alone on a narrow residential side street in flat afternoon light, closed rear doors, an empty pavement, a shopfront in the background, neutral documentary style.",
  },
  {
    id: "drawn-curtains",
    title: "The Drawn Curtains",
    description: "All week the curtains of a corner flat have been drawn in the early evening and opened again at dawn. The tenant, who normally keeps them open, has not been seen coming or going.",
    evidence: [
      "The curtains were drawn at about 6 p.m. and opened at about 6 a.m. every day this week, give or take a few minutes.",
      "The tenant normally keeps the curtains open and has not been seen coming or going all week.",
      "The mail has been collected from the box each day, in the late morning.",
      "A neighbour heard a TV on and off in the evenings but no voices.",
      "The building manager says the tenant installed a smart-home hub last month; nobody knows which devices it controls.",
      "The tenant's car has not moved from its parking space all week.",
    ],
    interpretations: [
      { id: "smart-timer", label: "Smart-home timer", description: "The new smart-home hub runs a schedule that moves the curtains, and the tenant is simply away while the system keeps running." },
      { id: "hiding-at-home", label: "Tenant hiding indoors", description: "The tenant is at home but deliberately avoiding contact, staying inside and keeping a strict routine to appear absent." },
      { id: "someone-else-living", label: "A guest is staying", description: "A friend or relative is staying in the flat while the tenant is away, living there normally with their own early-to-bed routine." },
      { id: "caretaker-visits", label: "Daily caretaker", description: "The tenant is away and has asked someone to call in each morning and evening to open and close the curtains, collect the mail and switch on the TV." },
    ],
    imagePrompt: "A corner apartment block at dusk, one flat with heavy curtains pulled shut while its neighbours stay open, warm light leaking at the edges, quiet street below, no people.",
  },
];
