import { test } from "node:test";
import assert from "node:assert/strict";
import { PREPARED_CASES, validateScenarioCase, similarity, MAX_INTERPRETATION_SIMILARITY } from "../src/index";
import type { ScenarioCase } from "../src/index";

const good = PREPARED_CASES[0];
const mutate = (over: Partial<ScenarioCase>): unknown => ({ ...good, ...over });

test("at least five prepared cases exist and every one passes the schema", () => {
  assert.ok(PREPARED_CASES.length >= 5);
  for (const c of PREPARED_CASES) {
    const v = validateScenarioCase(c);
    assert.ok(v.ok, `${c.id}: ${v.ok ? "" : v.errors.join("; ")}`);
  }
  assert.equal(new Set(PREPARED_CASES.map((c) => c.id)).size, PREPARED_CASES.length); // unique scenario ids
});

test("each case has 3-6 evidence items, 3-4 interpretations with stable unique ids, and an image prompt", () => {
  for (const c of PREPARED_CASES) {
    assert.ok(c.evidence.length >= 3 && c.evidence.length <= 6, c.id);
    assert.ok(c.interpretations.length >= 3 && c.interpretations.length <= 4, c.id);
    assert.equal(new Set(c.interpretations.map((i) => i.id)).size, c.interpretations.length);
    assert.ok(c.imagePrompt.length >= 20);
    for (const i of c.interpretations) assert.match(i.id, /^[a-z0-9][a-z0-9_-]{1,39}$/);
  }
});

test("candidate interpretations are distinct conclusions, not paraphrases (word overlap stays well under the limit)", () => {
  for (const c of PREPARED_CASES) {
    const ids = c.interpretations;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) assert.ok(similarity(ids[i].description, ids[j].description) < MAX_INTERPRETATION_SIMILARITY, `${c.id}: ${ids[i].id} vs ${ids[j].id}`);
  }
});

test("invalid cases are rejected: too few/many items, duplicate ids, paraphrases, empty text, bad ids", () => {
  const interp = good.interpretations;
  const cases: [string, unknown][] = [
    ["two interpretations", mutate({ interpretations: interp.slice(0, 2) })],
    ["five interpretations", mutate({ interpretations: [...interp, { id: "extra-one", label: "Extra", description: "Yet another explanation about something entirely unconnected." }] })],
    ["two evidence items", mutate({ evidence: good.evidence.slice(0, 2) })],
    ["seven evidence items", mutate({ evidence: [...good.evidence, "One more observation here.", "And one more observation."] })],
    ["duplicate interpretation ids", mutate({ interpretations: [interp[0], { ...interp[1], id: interp[0].id }, interp[2]] })],
    ["duplicate evidence", mutate({ evidence: [good.evidence[0], good.evidence[0].toUpperCase(), good.evidence[2]] })],
    ["near-paraphrase", mutate({ interpretations: [interp[0], { id: "same-thing", label: "Same thing again", description: interp[0].description.replace("Someone", "A person") }, interp[2]] })],
    ["empty title", mutate({ title: " " })],
    ["bad scenario id", mutate({ id: "Bad Id!" })],
    ["missing image prompt", mutate({ imagePrompt: "" })],
    ["not an object", "nope"],
  ];
  for (const [name, c] of cases) assert.equal(validateScenarioCase(c).ok, false, name);
});
