import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_PROVIDER, loadEngineConfig } from "../src/config";
import { claudeEngineConfig } from "../scripts/lib";

test("production configuration: with nothing configured every role is Claude Sonnet 5.5 on Anthropic at low effort", () => {
  assert.deepEqual([DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_EFFORT], ["anthropic", "claude-sonnet-5-5", "low"]);
  const c = loadEngineConfig({});
  for (const role of [c.agentA, c.agentB, c.judge]) assert.deepEqual([role.provider, role.model, role.effort, role.thinking], ["anthropic", "claude-sonnet-5-5", "low", undefined]);
  assert.deepEqual([c.agentA.maxOutputTokens, c.agentB.maxOutputTokens, c.judge.maxOutputTokens], [4096, 4096, 2500]);
  assert.equal(c.publicWordLimit, undefined); // the engine default (45) applies
  // the benchmark harness and the backend-facing configuration agree
  const h = claudeEngineConfig({});
  assert.deepEqual([h.agentA.model, h.agentB.model, h.judge.model, h.agentA.effort], [c.agentA.model, c.agentB.model, c.judge.model, c.agentA.effort]);
});

test("per-role overrides still win: Haiku, another Claude model, OpenRouter; a configured model is used exactly as given", () => {
  const c = loadEngineConfig({ AGENT_A_MODEL: "claude-haiku-5-5", AGENT_B_PROVIDER: "openrouter", AGENT_B_MODEL: "deepseek/deepseek-chat", JUDGE_MODEL: "claude-opus-5-5", JUDGE_EFFORT: "medium" });
  assert.deepEqual([c.agentA.provider, c.agentA.model, c.agentA.effort], ["anthropic", "claude-haiku-5-5", "low"]);
  assert.deepEqual([c.agentB.provider, c.agentB.model, c.agentB.effort], ["openrouter", "deepseek/deepseek-chat", undefined]); // effort is Anthropic-only
  assert.deepEqual([c.judge.model, c.judge.effort], ["claude-opus-5-5", "medium"]);
  assert.equal(loadEngineConfig({ AGENT_A_PROVIDER: "anthropic", AGENT_A_EFFORT: "high" }).agentA.effort, "high");
});

test("no default is invented for other providers or ambiguous models", () => {
  assert.throws(() => loadEngineConfig({ AGENT_A_PROVIDER: "openrouter" }), ConfigError); // OpenRouter needs an explicit model
  assert.throws(() => loadEngineConfig({ AGENT_B_MODEL: "deepseek/deepseek-chat" }), /AGENT_B_PROVIDER must be/); // a non-Claude model needs its provider
  assert.throws(() => loadEngineConfig({ JUDGE_PROVIDER: "other" }), ConfigError);
});

test("Sonnet's reasoning is untouched: no thinking switch is set by default, effort stays low, and only an explicit flag changes it", () => {
  const c = loadEngineConfig({});
  assert.ok([c.agentA, c.agentB, c.judge].every((m) => m.thinking === undefined && m.reasoning === undefined));
  const h = claudeEngineConfig({ TEST_AGENT_THINKING: "disabled" });
  assert.equal(h.agentA.thinking, "disabled"); // diagnostic only (Haiku); never applied to the judge
  assert.equal(h.judge.thinking, undefined);
});
