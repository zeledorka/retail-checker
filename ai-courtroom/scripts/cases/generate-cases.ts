/**
 * Case-generation pipeline. LOCAL SCRIPT ONLY (secret key + paid providers): never import this from the app.
 *
 *   npx tsx --env-file=.env scripts/cases/generate-cases.ts --count 3                 plan only: prints the cost, makes NO requests
 *   npx tsx --env-file=.env scripts/cases/generate-cases.ts --count 3 --approved      generate, upload images, upsert cases (PAID)
 *   npx tsx --env-file=.env scripts/cases/generate-cases.ts --count 1 --dry-run --approved   generate + validate, no upload/insert (PAID)
 *   npx tsx --env-file=.env scripts/cases/generate-cases.ts --count 1 --dry-run --mock       whole pipeline with mock providers (FREE)
 *   npx tsx --env-file=.env scripts/cases/generate-cases.ts --backfill-images [--approved] [--dry-run]
 *        images for existing cases whose image_url is null (1 paid image request per case)
 *
 * Flags: --count N (default 1) | --backup (mark generated cases is_backup) | --dry-run | --mock (requires --dry-run)
 *        --approved (required for ANY paid request, dry-run included) | --backfill-images
 *
 * Per generated case: Dev 2's prepareNewRound (≈5 requests: 1 scenario + 2 opinions + 1 checker [Claude] + 1 image [OpenRouter];
 * bounded retries can add more) → Dev 1's startRound validates it → image uploaded to Storage → row upserted into `cases`.
 * If the image fails, the case is still inserted with image_url = null (the frontend shows a placeholder).
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
 *      OPENROUTER_IMAGE_MODEL (optional), CASE_IMAGES_BUCKET (optional, default "case-images").
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateText, startRound, type Scenario } from '../../../ai/src/index';
import {
  buildImagePrompt, createLlmChecker, createLlmOpinionGenerator, createOpenRouterImageGenerator, DEFAULT_IMAGE_MODEL,
  newSeed, prepareNewRound, type ImageAsset, type ImageGenerator, type ScenarioInput,
} from '../../../scenarios/src/index';
import { MAX_TURNS } from '../../lib/game/constants';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const COUNT = Number(opt('--count') ?? 1);
const BACKUP = flag('--backup');
const DRY = flag('--dry-run');
const MOCK = flag('--mock');
const APPROVED = flag('--approved');
const BACKFILL = flag('--backfill-images');
const BUCKET = process.env.CASE_IMAGES_BUCKET || 'case-images';
const IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;

type CaseRow = {
  id: string; title: string; description: string; interpretation_a: string; interpretation_b: string;
  evidence_json: string[]; image_url: string | null; is_backup: boolean;
};

/** Mock providers (Dev 2's test fixtures): no network, no key, no cost. Only allowed with --dry-run. */
async function mockProviders() {
  const f = await import('../../../scenarios/test/full-fixtures');
  return { generate: f.scenarioWriter(), generator: f.mockOpinions(), checker: f.mockChecker(), imageGenerator: f.mockImage() as ImageGenerator };
}
function liveProviders() {
  return {
    generate: generateText,
    generator: createLlmOpinionGenerator(generateText),
    checker: createLlmChecker(generateText),
    imageGenerator: createOpenRouterImageGenerator(),
  };
}

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY missing: run with --env-file=.env');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Dev 1's engine must accept the case exactly as the game will load it (same check as make-seed). */
function validate(id: string, scenario: Scenario): string | null {
  const r = startRound({ roundId: `gen-check-${id}`, scenario, maxTurns: MAX_TURNS });
  return r.ok ? null : r.error.message;
}

async function ensureBucket(db: SupabaseClient) {
  const { data } = await db.storage.getBucket(BUCKET);
  if (data) {
    if (!data.public) throw new Error(`bucket "${BUCKET}" exists but is not public; make it public in Supabase Storage`);
    return;
  }
  const { error } = await db.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], fileSizeLimit: '10MB' });
  if (error) throw new Error(`could not create bucket "${BUCKET}": ${error.message}`);
  console.log(`created public bucket "${BUCKET}"`);
}

/** Upload the image bytes; returns the public URL, or null (logged) on failure so the case is still usable. */
async function upload(db: SupabaseClient, caseId: string, asset: ImageAsset): Promise<string | null> {
  const path = `${caseId}/${asset.filename}`;
  const { error } = await db.storage.from(BUCKET).upload(path, asset.bytes, { contentType: asset.mimeType, upsert: true });
  if (error) { console.warn(`  ! upload failed (${error.message}); inserting with image_url = null`); return null; }
  return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
function printCase(row: CaseRow) {
  console.log(`  id:        ${row.id}${row.is_backup ? ' (backup)' : ''}`);
  console.log(`  title:     ${row.title}`);
  console.log(`  desc:      ${short(row.description)}`);
  row.evidence_json.forEach((e, i) => console.log(`  e${i + 1}:        ${short(e)}`));
  console.log(`  A:         ${short(row.interpretation_a)}`);
  console.log(`  B:         ${short(row.interpretation_b)}`);
}

async function generateMode() {
  const providers = MOCK ? await mockProviders() : liveProviders();
  const db = DRY && MOCK ? null : admin();
  if (db && !DRY) await ensureBucket(db);
  // Existing titles steer the writer away from repeats (read-only).
  const recentTitles = db ? ((await db.from('cases').select('title')).data ?? []).map((r) => r.title as string) : [];

  let inserted = 0, withoutImage = 0, failed = 0, imageUsd = 0, claudeUsd = 0;
  for (let i = 0; i < COUNT; i++) {
    const seed = newSeed();
    console.log(`\n[${i + 1}/${COUNT}] prepareNewRound seed=${seed}${MOCK ? ' (MOCK providers)' : ''}`);
    const prep = await prepareNewRound({ seed, ...providers, recentTitles });

    let id: string, scenario: Scenario, asset: ImageAsset | null = null;
    if (prep.ok) {
      id = prep.publicCase.scenarioId;
      scenario = prep.scenario;
      asset = prep.image;
      claudeUsd += prep.server.usage.estimatedClaudeUsd;
      imageUsd += prep.server.usage.imageCostUsd ?? 0;
      console.log(`  requests:  ${JSON.stringify(prep.server.requests)}  time ${prep.server.timing.totalMs} ms  source=${prep.source}`);
      console.log(`  cost${MOCK ? ' (mock fixture numbers, nothing spent)' : ''}:      ~$${prep.server.usage.estimatedClaudeUsd.toFixed(4)} Claude (estimate) + $${(prep.server.usage.imageCostUsd ?? 0).toFixed(4)} image (reported)`);
    } else if (prep.stage === 'image' && prep.preserved) {
      // Scenario + locked opinions exist; only the image failed → still a valid case, without an image.
      id = prep.preserved.scenario.id;
      scenario = prep.preserved.opinions.scenario;
      console.warn(`  ! image failed (${prep.preserved.imageError.code}: ${prep.preserved.imageError.message}); continuing without image`);
    } else {
      failed++;
      console.error(`  ✗ preparation failed at ${prep.stage}: ${prep.message}  requests=${JSON.stringify(prep.requests)}`);
      continue;
    }

    const problem = validate(id, scenario);
    if (problem) { failed++; console.error(`  ✗ rejected by startRound: ${problem}`); continue; }
    console.log('  startRound: accepted');
    console.log(asset ? `  image:     ${asset.filename} ${asset.mimeType} ${asset.byteLength} bytes (${asset.model})` : '  image:     none');

    const row: CaseRow = {
      id, title: scenario.title, description: scenario.description,
      interpretation_a: scenario.interpretationA, interpretation_b: scenario.interpretationB,
      evidence_json: scenario.evidence, image_url: null, is_backup: BACKUP,
    };
    printCase(row);
    if (DRY) { console.log('  dry-run:   not uploaded, not inserted'); continue; }

    row.image_url = asset ? await upload(db!, id, asset) : null;
    if (!row.image_url) withoutImage++;
    const { error } = await db!.from('cases').upsert(row, { onConflict: 'id' });
    if (error) { failed++; console.error(`  ✗ upsert failed: ${error.message}`); continue; }
    inserted++;
    recentTitles.push(row.title);
    console.log(`  ✓ upserted${row.image_url ? ` with image ${row.image_url}` : ' with image_url = null'}`);
  }
  console.log(`\nDone: ${DRY ? `${COUNT - failed} validated (dry-run)` : `${inserted} upserted (${withoutImage} without image)`}, ${failed} failed. ` +
    `Spend${MOCK ? ' (mock, nothing spent)' : ''}: ~$${claudeUsd.toFixed(4)} Claude (estimate) + $${imageUsd.toFixed(4)} image (reported).`);
  if (failed) process.exitCode = 1;
}

async function backfillMode() {
  const db = admin();
  const { data, error } = await db.from('cases').select('*').is('image_url', null).order('id');
  if (error) throw error;
  const rows = (data ?? []) as CaseRow[];
  console.log(`${rows.length} case(s) without image: ${rows.map((r) => r.id).join(', ') || '(none)'}`);
  if (!rows.length) return;
  const imageGenerator = MOCK ? (await mockProviders()).imageGenerator : createOpenRouterImageGenerator();
  if (!DRY) await ensureBucket(db);
  let done = 0;
  for (const r of rows) {
    // Public facts only (same as prepareNewRound): title, description, evidence. Never the interpretations.
    const scenario: ScenarioInput = { id: r.id, title: r.title, description: r.description, evidence: r.evidence_json.map((text, i) => ({ id: `e${i + 1}`, text })) };
    const res = await imageGenerator.generate({ scenario, prompt: buildImagePrompt(scenario) });
    if (!res.ok) { console.warn(`  ! ${r.id}: image failed (${res.error.code}: ${res.error.message}); left as null`); continue; }
    console.log(`  ${r.id}: ${res.asset.filename} ${res.asset.byteLength} bytes${res.telemetry.costUsd !== undefined ? ` $${res.telemetry.costUsd}` : ''}`);
    if (DRY) continue;
    const url = await upload(db, r.id, res.asset);
    if (!url) continue;
    const { error: e } = await db.from('cases').update({ image_url: url }).eq('id', r.id).is('image_url', null);
    if (e) { console.warn(`  ! ${r.id}: update failed: ${e.message}`); continue; }
    done++;
  }
  console.log(`\nBackfill: ${DRY ? 'dry-run, nothing uploaded' : `${done}/${rows.length} cases now have an image`}.`);
}

async function main() {
  if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 20) throw new Error('--count must be an integer 1-20');
  if (MOCK && !DRY) throw new Error('--mock only works with --dry-run (mock cases/images must never reach the database)');
  console.log(`generate-cases: mode=${BACKFILL ? 'backfill-images' : 'generate'} count=${COUNT} dry-run=${DRY} mock=${MOCK} backup=${BACKUP} bucket=${BUCKET} image-model=${IMAGE_MODEL}`);

  if (!MOCK) {
    const need = BACKFILL ? ['OPENROUTER_API_KEY'] : ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
    const missing = need.filter((k) => !process.env[k]);
    const plan = BACKFILL
      ? 'Plan: 1 paid OpenRouter image request per case with image_url = null.'
      : `Plan: ${COUNT} case(s) × ≈5 paid requests (4 Claude + 1 OpenRouter image; bounded retries can add a few) = ≈${COUNT * 5} requests.`;
    if (!APPROVED) {
      console.log(`${plan}\nNo requests made. Re-run with --approved to spend credit${DRY ? '' : ' and write to Supabase'}, or use --dry-run --mock for a free run.`);
      if (missing.length) console.log(`Missing env vars for a live run: ${missing.join(', ')}`);
      return;
    }
    if (missing.length) throw new Error(`missing env vars: ${missing.join(', ')}`);
  }
  await (BACKFILL ? backfillMode() : generateMode());
}

main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
