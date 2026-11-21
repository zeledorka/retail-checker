import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMAGE_MODEL, buildImagePrompt, createOpenRouterImageGenerator, decodeImageResponse, saveImageLocally, toImageInfo, verifyImageModel } from "../src/index";
import type { ScenarioInput } from "../src/index";
import { DESIGNS, EVIDENCE, PNG_B64 } from "./full-fixtures";

const scenario: ScenarioInput = { id: "missing-keg-ab12", title: "The Keg That Moved", description: "At closing time the brewery's biggest keg was gone from its rack, though the door was locked all evening.", evidence: EVIDENCE.map((text, k) => ({ id: `e${k + 1}`, text })), imagePrompt: "A quiet brewery interior at dusk with an empty keg rack and a closed loading door" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const good = { created: 1, data: [{ b64_json: PNG_B64, media_type: "image/png" }], usage: { cost: 0.031, completion_tokens: 1120, total_tokens: 1120 } };
function fetchSpy(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(); }) as unknown as typeof fetch;
  return { fn, calls };
}
const gen = (fetchFn: typeof fetch, env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "sk-test-key-123" }, extra = {}) => createOpenRouterImageGenerator({ fetchFn, env, ...extra });

test("the request goes to the Images API with bearer auth, the default model, one 16:9 b64_json image, and the key only in the header", async () => {
  const { fn, calls } = fetchSpy(() => json(good));
  const prompt = buildImagePrompt(scenario);
  const r = await gen(fn).generate({ scenario, prompt });
  assert.ok(r.ok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
  assert.equal(calls[0].init.method, "POST");
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer sk-test-key-123");
  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body, { model: "google/gemini-3.1-flash-lite-image", prompt, n: 1, aspect_ratio: "16:9", response_format: "b64_json" });
  assert.equal(DEFAULT_IMAGE_MODEL, "google/gemini-3.1-flash-lite-image");
  assert.ok(!(calls[0].init.body as string).includes("sk-test-key"));
  assert.ok(!JSON.stringify(r).includes("sk-test-key"));
});

test("the model is configurable by OPENROUTER_IMAGE_MODEL or an option, and is never silently replaced", async () => {
  const a = fetchSpy(() => json(good));
  await gen(a.fn, { OPENROUTER_API_KEY: "k", OPENROUTER_IMAGE_MODEL: "vendor/other-image" }).generate({ scenario, prompt: "p" });
  assert.equal(JSON.parse(a.calls[0].init.body as string).model, "vendor/other-image");
  const b = fetchSpy(() => json(good));
  await gen(b.fn, { OPENROUTER_API_KEY: "k", OPENROUTER_IMAGE_MODEL: "vendor/other-image" }, { model: "explicit/model" }).generate({ scenario, prompt: "p" });
  assert.equal(JSON.parse(b.calls[0].init.body as string).model, "explicit/model");
  const missing = fetchSpy(() => json({ error: { message: "No endpoints found for model" } }, 404));
  const r = await gen(missing.fn, { OPENROUTER_API_KEY: "k", OPENROUTER_IMAGE_MODEL: "vendor/gone" }).generate({ scenario, prompt: "p" });
  assert.ok(!r.ok && r.error.code === "unsupported_model" && /vendor\/gone/.test(r.error.message));
  assert.equal(missing.calls.length, 1); // no fallback model, no retry
});

test("a successful response is decoded to real bytes with the correct MIME type, a hash and cost telemetry", async () => {
  const { fn } = fetchSpy(() => json(good));
  const r = await gen(fn).generate({ scenario, prompt: "p" });
  assert.ok(r.ok);
  assert.ok(r.asset.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(r.asset.bytes).toString("base64"), PNG_B64);
  assert.equal(r.asset.mimeType, "image/png");
  assert.match(r.asset.filename, /^missing-keg-ab12-[0-9a-f]{8}\.png$/);
  assert.equal(r.asset.byteLength, r.asset.bytes.byteLength);
  assert.equal(r.asset.sha256.length, 64);
  assert.equal(r.telemetry.costUsd, 0.031);
  assert.equal(r.telemetry.model, "google/gemini-3.1-flash-lite-image");
  assert.ok(r.telemetry.latencyMs >= 0);
});

test("MIME handling: the type is verified from the bytes (JPEG, WebP, a wrong or missing media_type)", () => {
  const ctx = { model: "m", prompt: "p", scenarioId: "s" };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30, 1)]).toString("base64");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.alloc(20, 2)]).toString("base64");
  const j = decodeImageResponse({ data: [{ b64_json: jpeg, media_type: "image/png" }] }, ctx);
  assert.ok(j.ok && j.asset.mimeType === "image/jpeg" && j.asset.filename.endsWith(".jpg")); // the bytes win over a wrong claim
  const w = decodeImageResponse({ data: [{ b64_json: webp }] }, ctx);
  assert.ok(w.ok && w.asset.mimeType === "image/webp");
});

test("invalid responses are rejected: no data, URL instead of data, bad base64, bytes that are not an image, empty list", () => {
  const ctx = { model: "m", prompt: "p", scenarioId: "s" };
  const cases: [string, unknown][] = [
    ["empty body", {}],
    ["empty data", { data: [] }],
    ["url only", { data: [{ url: "https://example.com/x.png", media_type: "image/png" }] }],
    ["not base64", { data: [{ b64_json: "%%%not base64%%%" }] }],
    ["text bytes", { data: [{ b64_json: Buffer.from("this is not an image at all, just text").toString("base64") }] }],
    ["empty string", { data: [{ b64_json: "" }] }],
    ["null", null],
  ];
  for (const [name, body] of cases) {
    const r = decodeImageResponse(body, ctx);
    assert.ok(!r.ok && r.error.code === "invalid_response", name);
  }
});

test("failures are typed: missing key (no request), HTTP errors, rate limit, timeout, network error, unparseable body", async () => {
  const none = fetchSpy(() => json(good));
  const m = await gen(none.fn, {}).generate({ scenario, prompt: "p" });
  assert.ok(!m.ok && m.error.code === "missing_key" && !m.error.retryable);
  assert.equal(none.calls.length, 0);
  const s500 = await gen(fetchSpy(() => json({ error: { message: "upstream" } }, 502)).fn).generate({ scenario, prompt: "p" });
  assert.ok(!s500.ok && s500.error.code === "http_error" && s500.error.retryable && s500.error.status === 502);
  const s429 = await gen(fetchSpy(() => json({ error: { message: "slow down" } }, 429)).fn).generate({ scenario, prompt: "p" });
  assert.ok(!s429.ok && s429.error.retryable);
  const s401 = await gen(fetchSpy(() => json({ error: { message: "bad key" } }, 401)).fn).generate({ scenario, prompt: "p" });
  assert.ok(!s401.ok && s401.error.code === "http_error" && !s401.error.retryable);
  const html = await gen(fetchSpy(() => new Response("<html>oops</html>", { status: 200 })).fn).generate({ scenario, prompt: "p" });
  assert.ok(!html.ok && html.error.code === "invalid_response");
  const net = await gen((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch).generate({ scenario, prompt: "p" });
  assert.ok(!net.ok && net.error.code === "network");
  const hang = (async (_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  const t = await gen(hang, { OPENROUTER_API_KEY: "k" }, { timeoutMs: 20 }).generate({ scenario, prompt: "p" });
  assert.ok(!t.ok && t.error.code === "timeout");
});

test("the image prompt is built from public facts only", () => {
  const p = buildImagePrompt(scenario);
  assert.ok(p.includes(scenario.imagePrompt!));
  for (const e of scenario.evidence) assert.ok(p.includes(e.text));
  for (const d of DESIGNS) assert.ok(!p.toLowerCase().includes(d.mechanism.toLowerCase()) && !p.includes(d.label));
  assert.match(p, /No text, no signs/);
  assert.match(p, /do not add clues, culprits or explanations/);
  assert.ok(buildImagePrompt({ ...scenario, imagePrompt: undefined }).includes(scenario.description));
});

test("image bytes are never stored as a URL or inside JSON state: info is bytes-free, files go to a local folder", async () => {
  const { fn } = fetchSpy(() => json(good));
  const r = await gen(fn).generate({ scenario, prompt: "p" });
  assert.ok(r.ok);
  const info = toImageInfo(r.asset);
  assert.ok(!("bytes" in info) && !("prompt" in info) && !("url" in info));
  assert.ok(!JSON.stringify(info).includes(PNG_B64) && !/https?:/.test(JSON.stringify(info)));
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  try {
    const path = saveImageLocally(r.asset, dir);
    assert.deepEqual(new Uint8Array(readFileSync(path)), r.asset.bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the free catalog check reports a listed model, a missing model and an unreachable catalog", async () => {
  const cat = (data: unknown) => (async () => json({ data })) as unknown as typeof fetch;
  assert.ok((await verifyImageModel("a/b", cat([{ id: "a/b", supported_parameters: { aspect_ratio: { values: ["16:9"] } } }]))).ok);
  assert.ok(!(await verifyImageModel("a/b", cat([{ id: "x/y" }]))).ok);
  assert.ok(!(await verifyImageModel("a/b", cat([{ id: "a/b", supported_parameters: { aspect_ratio: { values: ["1:1"] } } }]))).ok);
  assert.ok(!(await verifyImageModel("a/b", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).ok);
});
