import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioInput } from "./opinion-types";

/**
 * Scenario image generation through OpenRouter's Images API (POST /api/v1/images). One request, one landscape image, decoded to real
 * bytes. No OpenAI key or SDK. Verified 2026-11-21 against GET /api/v1/images/models: `google/gemini-3.1-flash-lite-image` supports
 * aspect_ratio (incl. 16:9), n = 1 only, output via b64_json + media_type, billed per output token (about $0.00003 each at the time).
 * Status: only run with mocked responses so far.
 */
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";
export const IMAGE_ASPECT_RATIO = "16:9";

export type ImageErrorCode = "missing_key" | "unsupported_model" | "invalid_response" | "http_error" | "timeout" | "network";
export type ImageError = { code: ImageErrorCode; message: string; status?: number; retryable: boolean };
export type ImageTelemetry = { model: string; latencyMs: number; /** actual provider-reported USD cost (usage.cost), when present */ costUsd?: number; completionTokens?: number; totalTokens?: number };

/** What Developer 3 uploads (e.g. to Supabase Storage). Bytes live here only: never put them in AI round JSON state. */
export type ImageAsset = { id: string; filename: string; mimeType: string; byteLength: number; sha256: string; bytes: Uint8Array; model: string; prompt: string };
/** The JSON-safe description of an image (no bytes) that may go in public state once a storage URL exists. */
export type ImageInfo = Omit<ImageAsset, "bytes" | "prompt"> & { url?: string };
export type ImageResult = { ok: true; asset: ImageAsset; telemetry: ImageTelemetry } | { ok: false; error: ImageError; telemetry?: Partial<ImageTelemetry> };
export interface ImageGenerator {
  generate(request: { scenario: ScenarioInput; prompt: string }): Promise<ImageResult>;
}

export const toImageInfo = ({ bytes: _b, prompt: _p, ...info }: ImageAsset): ImageInfo => info;

const STYLE = "Cinematic, atmospheric, realistic landscape composition suited to a projected screen, natural lighting appropriate to the scene. No text, no signs, no captions, no identifiable faces, no one caught in the act. Illustrate only the setting and the visible facts described; do not add clues, culprits or explanations.";
/** The image prompt comes from PUBLIC facts only: the scenario's public image prompt, its title and its evidence texts. */
export function buildImagePrompt(s: ScenarioInput): string {
  const facts = s.evidence.map((e) => e.text).join(" ");
  return `${s.imagePrompt ?? s.description}\nVisible facts to stay consistent with: ${facts}\n${STYLE}`;
}

function sniff(b: Uint8Array): string | undefined {
  const h = (...xs: number[]) => xs.every((x, i) => b[i] === x);
  if (b.length > 12 && h(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (b.length > 12 && h(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length > 12 && h(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length > 12 && h(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return undefined;
}
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Decodes an Images API response body into a binary asset. base64 is decoded to bytes and the type is verified from the bytes themselves. */
export function decodeImageResponse(body: unknown, ctx: { model: string; prompt: string; scenarioId: string }): { ok: true; asset: ImageAsset; usage?: { cost?: number; completion_tokens?: number; total_tokens?: number } } | { ok: false; error: ImageError } {
  const bad = (message: string): { ok: false; error: ImageError } => ({ ok: false, error: { code: "invalid_response", message, retryable: false } });
  const o = (typeof body === "object" && body !== null ? body : {}) as { data?: { b64_json?: unknown; media_type?: unknown; url?: unknown }[]; usage?: { cost?: number; completion_tokens?: number; total_tokens?: number } };
  const item = Array.isArray(o.data) ? o.data[0] : undefined;
  if (!item) return bad("the response contains no image");
  if (typeof item.b64_json !== "string" || !item.b64_json) return bad(typeof item.url === "string" ? "the response is a URL, not image data (b64_json was requested)" : "the response has no b64_json image data");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(item.b64_json)) return bad("b64_json is not valid base64");
  const bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
  const mime = sniff(bytes);
  if (!mime) return bad("the decoded bytes are not a PNG, JPEG, WebP or GIF image");
  const claimed = typeof item.media_type === "string" ? item.media_type : undefined;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = `${ctx.scenarioId}-${sha256.slice(0, 8)}`;
  // The sniffed type wins over a mismatching claim; a mismatch is not fatal because the bytes are what gets stored.
  void claimed;
  return { ok: true, asset: { id, filename: `${id}.${EXT[mime]}`, mimeType: mime, byteLength: bytes.byteLength, sha256, bytes, model: ctx.model, prompt: ctx.prompt }, usage: o.usage };
}

export type OpenRouterImageOptions = { apiKey?: string; model?: string; fetchFn?: typeof fetch; timeoutMs?: number; env?: Record<string, string | undefined> };

/** Real generator. Reads OPENROUTER_API_KEY and OPENROUTER_IMAGE_MODEL from the environment unless given. Never retries; never substitutes a model. */
export function createOpenRouterImageGenerator(opts: OpenRouterImageOptions = {}): ImageGenerator {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async generate({ scenario, prompt }) {
      const apiKey = opts.apiKey ?? env.OPENROUTER_API_KEY;
      const model = opts.model ?? env.OPENROUTER_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
      if (!apiKey) return { ok: false, error: { code: "missing_key", message: "OPENROUTER_API_KEY is not set", retryable: false } };
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
      try {
        const res = await fetchFn(`${OPENROUTER_BASE}/images`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: IMAGE_ASPECT_RATIO, response_format: "b64_json" }),
          signal: ctl.signal,
        });
        const latencyMs = Date.now() - t0;
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        if (!res.ok) {
          const msg = ((json as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200)) || res.statusText;
          // 404, or a 400 that names the model, means the model is not served by the Images API: report it, never swap models.
          const unsupported = res.status === 404 || (res.status === 400 && /model/i.test(msg));
          return { ok: false, error: { code: unsupported ? "unsupported_model" : "http_error", message: unsupported ? `model "${model}" is not available through the Images API: ${msg}` : `OpenRouter returned ${res.status}: ${msg}`, status: res.status, retryable: res.status >= 500 || res.status === 429 }, telemetry: { model, latencyMs } };
        }
        const d = decodeImageResponse(json, { model, prompt, scenarioId: scenario.id });
        if (!d.ok) return { ...d, telemetry: { model, latencyMs } };
        return { ok: true, asset: d.asset, telemetry: { model, latencyMs, costUsd: d.usage?.cost, completionTokens: d.usage?.completion_tokens, totalTokens: d.usage?.total_tokens } };
      } catch (e) {
        const aborted = (e as { name?: string }).name === "AbortError";
        return { ok: false, error: { code: aborted ? "timeout" : "network", message: aborted ? "the image request timed out" : `network error: ${(e as Error).message}`, retryable: true }, telemetry: { model, latencyMs: Date.now() - t0 } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Optional free check (GET, no key, no charge): is the model listed by the Images API, and does it support 16:9? */
export async function verifyImageModel(model: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchFn(`${OPENROUTER_BASE}/images/models`);
    if (!res.ok) return { ok: false, message: `model catalog returned ${res.status}` };
    const list = ((await res.json()) as { data?: { id: string; supported_parameters?: { aspect_ratio?: { values?: string[] } } }[] }).data ?? [];
    const m = list.find((x) => x.id === model);
    if (!m) return { ok: false, message: `model "${model}" is not in the Images API catalog` };
    const ratios = m.supported_parameters?.aspect_ratio?.values;
    return ratios && !ratios.includes(IMAGE_ASPECT_RATIO) ? { ok: false, message: `model "${model}" does not list aspect ratio ${IMAGE_ASPECT_RATIO}` } : { ok: true, message: `model "${model}" is listed` };
  } catch (e) {
    return { ok: false, message: `could not reach the model catalog: ${(e as Error).message}` };
  }
}

/** Local development only: writes the asset into a git-ignored folder (default scenarios/output). Developer 3 uploads `asset.bytes` to storage instead. */
export function saveImageLocally(asset: ImageAsset, dir: string = join(process.cwd(), "output")): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, asset.filename);
  writeFileSync(path, asset.bytes);
  return path;
}
