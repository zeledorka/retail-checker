import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIO_SYSTEM, buildImagePrompt, buildScenarioPrompt, generateNewScenario, pickHints, validateDesignedScenario } from "../src/index";
import { DESIGNS, EVIDENCE, designed, ok, scenarioWriter } from "./full-fixtures";

test("a valid designed scenario becomes a public scenario with stable evidence ids, and the private designs stay separate", async () => {
  const r = await generateNewScenario({ generate: scenarioWriter(), seed: 5 });
  assert.ok(r.ok);
  assert.deepEqual(r.scenario.evidence.map((e) => e.id), EVIDENCE.map((_, k) => `e${k + 1}`));
  assert.match(r.scenario.id, /^missing-keg-[a-z0-9]{1,4}$/);
  assert.equal(r.design.designs.length, 3);
  assert.ok(!("designs" in r.scenario) && !("design" in r.scenario));
  assert.equal(r.telemetry?.inputTokens, 700);
  assert.match(SCENARIO_SYSTEM, /design two or three genuinely different causal explanations/);
  assert.match(SCENARIO_SYSTEM, /without proving any of them/);
});

test("scenario ids are unique per seed even when the model reuses a slug", async () => {
  const ids = new Set<string>();
  for (let s = 0; s < 20; s++) {
    const r = await generateNewScenario({ generate: scenarioWriter(), seed: s });
    assert.ok(r.ok);
    ids.add(r.scenario.id);
  }
  assert.ok(ids.size >= 19);
});

test("invalid and inconsistent scenarios are rejected with specific reasons", () => {
  const rejects: [string, unknown][] = [
    ["two evidence items", designed({ evidence: EVIDENCE.slice(0, 2) })],
    ["seven evidence items", designed({ evidence: [...EVIDENCE, "Another thing happened here.", "A final thing happened too."] })],
    ["duplicate evidence", designed({ evidence: [EVIDENCE[0], EVIDENCE[0], EVIDENCE[2]] })],
    ["one design", designed({ designs: DESIGNS.slice(0, 1) })],
    ["four designs", designed({ designs: [...DESIGNS, { label: "Fourth idea here", mechanism: "A power cut reset every sensor in the building overnight." }] })],
    ["paraphrased designs", designed({ designs: [DESIGNS[0], { label: "Same again", mechanism: "A colleague deliberately moved the keg to the cold room to protect a surprise order, deliberately." }] })],
    ["design copied into evidence", designed({ evidence: [DESIGNS[1].mechanism, EVIDENCE[1], EVIDENCE[2]] })],
    ["design label copied into description", designed({ description: "At closing time the keg was gone: a Delivery mix-up happened somewhere, and nobody remembers moving it, which is puzzling." })],
    ["verdict in evidence", designed({ evidence: [EVIDENCE[0], "A camera clip proves the keg was taken by the night cook.", EVIDENCE[2]] })],
    ["explanations mentioned publicly", designed({ evidence: [EVIDENCE[0], "One theory says the scanner is wrong.", EVIDENCE[2]] })],
    ["image prompt shows an escape", designed({ imagePrompt: "A thief escaping from the brewery through a side door at night with the keg" })],
    ["evidence too short", designed({ evidence: ["Door.", EVIDENCE[1], EVIDENCE[2]] })],
    ["bad id", designed({ id: "Bad ID!" })],
    ["missing field", (() => { const d: Record<string, unknown> = designed(); delete d.title; return d; })()],
  ];
  for (const [name, raw] of rejects) assert.equal(validateDesignedScenario(raw, 1).ok, false, name);
  assert.ok(validateDesignedScenario(designed(), 1).ok);
});

test("non-JSON and provider errors are typed, and the raw reply is kept", async () => {
  const bad = await generateNewScenario({ generate: scenarioWriter(() => "Sorry, here is a story instead."), seed: 1 });
  assert.ok(!bad.ok && bad.error.code === "invalid_output" && bad.error.raw?.startsWith("Sorry"));
  const leaky = await generateNewScenario({ generate: scenarioWriter(() => designed({ evidence: [DESIGNS[0].mechanism, EVIDENCE[1], EVIDENCE[2]] })), seed: 1 });
  assert.ok(!leaky.ok && /leaks/.test(leaky.error.details!.join(" ")));
  const down = await generateNewScenario({ generate: async (c) => ({ ok: false, error: { kind: "timeout", message: "slow", provider: c.provider, model: c.model, retryable: true } }), seed: 1 });
  assert.ok(!down.ok && down.error.code === "model_error" && down.error.retryable);
});

test("variety: seeds pick different situation and setting hints, recent titles are passed on, and the same seed is reproducible", () => {
  const sit = new Set<string>();
  const set = new Set<string>();
  for (let s = 0; s < 60; s++) { const h = pickHints(s); sit.add(h.situation); set.add(h.setting); }
  assert.ok(sit.size >= 8 && set.size >= 15, `${sit.size} situations, ${set.size} settings`);
  assert.equal(buildScenarioPrompt(9), buildScenarioPrompt(9));
  assert.notEqual(buildScenarioPrompt(9), buildScenarioPrompt(10));
  const p = buildScenarioPrompt(3, ["The Keg That Moved", "The Silent Call"]);
  assert.match(p, /do not repeat these stories/);
  assert.ok(p.includes("The Keg That Moved") && p.includes("The Silent Call"));
  assert.doesNotMatch(SCENARIO_SYSTEM, /archetype|template/i);
});

test("private designs never reach public fields, the image prompt, or later requests", async () => {
  const r = await generateNewScenario({ generate: scenarioWriter(), seed: 2 });
  assert.ok(r.ok);
  const publicText = JSON.stringify(r.scenario) + buildImagePrompt(r.scenario);
  for (const d of DESIGNS) assert.ok(!publicText.toLowerCase().includes(d.mechanism.toLowerCase()) && !publicText.includes(d.label));
});

// ---- Regression: the first live benchmark rejected a coherent scenario because `setting` was 89 characters (limit was 80). ----
import { SCENARIO_ASKED, SCENARIO_LIMITS, buildImagePrompt as buildImg } from "../src/index";
const BAKERY = {
  designs: [
    { label: "Deliberate sabotage", mechanism: "A rival or coworker deliberately swapped the labels on the two wedding-cake boxes so the wrong cakes reached each venue." },
    { label: "Honest labeling slip", mechanism: "A tired packer attached labels from a reused sheet in the wrong order during the early rush, with no intent to harm." },
    { label: "Customer changed order", mechanism: "One client phoned in a last-minute venue switch that was noted on a loose slip, so the driver correctly delivered per the updated slip while the boxes' labels were outdated." },
  ],
  id: "swapped-wedding-cakes",
  title: "The Two Cakes at the Wrong Weddings",
  setting: "A small neighbourhood bakery with a loading counter and a van, on a busy Saturday morning",
  description: "Two wedding cakes made by the same bakery arrived at the wrong venues: a three-tier lemon cake went to a couple who ordered chocolate, and the chocolate cake went to the lemon couple. Both couples were furious, and the bakery staff each say they followed the paperwork, so nobody can explain how the cakes ended up swapped.",
  evidence: [
    "Both box labels were printed on the same sheet, and their order on the sheet matches the order of the bakery's morning pickups.",
    "The driver's clipboard has a handwritten slip, in pencil, with a venue name crossed out and rewritten.",
    "The bakery's phone log shows one call from a wedding client at 6:40 a.m., before the van left, with no note of what was discussed.",
    "The two boxes were stacked together in the walk-in fridge overnight, with the labels facing the back wall.",
    "The packer who sealed the boxes started her shift forty minutes earlier than usual that day.",
  ],
  imagePrompt: "Early morning inside a small bakery loading area: two tall white cake boxes on a steel counter beside a parked delivery van with open rear doors, a clipboard with a pencil slip, a wall phone, a walk-in fridge door ajar, warm golden light through the window, cinematic wide shot",
};

test("regression: the real bakery reply (89-character setting) now validates end to end", async () => {
  assert.equal(BAKERY.setting.length, 89);
  const r = await generateNewScenario({ generate: scenarioWriter(() => BAKERY), seed: 2026 });
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.error.details));
  assert.equal(r.scenario.title, "The Two Cakes at the Wrong Weddings");
  assert.equal(r.scenario.evidence.length, 5);
  assert.equal(r.design.setting, BAKERY.setting);
  assert.ok(buildImg(r.scenario).includes("bakery"));
});

test("the setting limit is 160: 160 characters pass, 161 fail; the prompt and validator agree on every limit", () => {
  assert.equal(SCENARIO_LIMITS.setting, 160);
  assert.ok(validateDesignedScenario(designed({ setting: "s".repeat(160) }), 1).ok);
  assert.equal(validateDesignedScenario(designed({ setting: "s".repeat(161) }), 1).ok, false);
  for (const k of Object.keys(SCENARIO_LIMITS) as (keyof typeof SCENARIO_LIMITS)[]) {
    assert.ok(SCENARIO_ASKED[k] < SCENARIO_LIMITS[k], `${k}: the prompt must ask for less than the hard limit`);
    assert.ok(SCENARIO_SYSTEM.includes(String(SCENARIO_ASKED[k])), `${k}: the prompt must state ${SCENARIO_ASKED[k]}`);
  }
  // hard limits stay inside what later stages accept (validateScenarioInput: title 80, description 1200, evidence 300, imagePrompt 600; startRound: 200/2000/400)
  assert.ok(SCENARIO_LIMITS.title <= 80 && SCENARIO_LIMITS.description <= 1200 && SCENARIO_LIMITS.evidence <= 300 && SCENARIO_LIMITS.imagePrompt <= 600);
});

test("structural validation is NOT weakened: evidence count, evidence length, duplicate evidence and designs still fail", () => {
  assert.equal(validateDesignedScenario(designed({ evidence: EVIDENCE.slice(0, 2) }), 1).ok, false);
  assert.equal(validateDesignedScenario(designed({ evidence: [EVIDENCE[0], "x".repeat(301), EVIDENCE[2]] }), 1).ok, false);
  assert.ok(validateDesignedScenario(designed({ evidence: [EVIDENCE[0], "x ".repeat(120).trim() + "y", EVIDENCE[2]] }), 1).ok); // 241 chars: over the asked 240, within the hard 300
  assert.equal(validateDesignedScenario(designed({ designs: DESIGNS.slice(0, 1) }), 1).ok, false);
  assert.equal(validateDesignedScenario(designed({ description: "d".repeat(701) }), 1).ok, false);
  assert.equal(validateDesignedScenario(designed({ imagePrompt: "p".repeat(601) }), 1).ok, false);
});
