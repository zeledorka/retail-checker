// Run database steps against Supabase without the SQL Editor (cross-platform).
//   npx tsx --env-file=.env scripts/dev/db.ts check            read-only counts + case ids
//   npx tsx --env-file=.env scripts/dev/db.ts cleanup          delete test rounds + non-seed cases (one transaction)
//   npx tsx --env-file=.env scripts/dev/db.ts apply <file.sql> run one SQL file in one transaction
//   npx tsx --env-file=.env scripts/dev/db.ts reload           notify pgrst, 'reload schema'
//   npx tsx --env-file=.env scripts/dev/db.ts verify           post-migration checks
// Needs SUPABASE_DB_URL (session pooler string). The URL is never printed.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const SEED_IDS = ['empty-display-case', 'silent-call', 'open-gate', 'missing-rows', 'parked-van', 'drawn-curtains'];

function redact(msg: string): string {
  const url = process.env.SUPABASE_DB_URL ?? '';
  return url ? msg.split(url).join('<SUPABASE_DB_URL>') : msg;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is not set (run with --env-file=.env)');
  // Supabase's pooler cert is not in Node's default CA store; the connection is still TLS-encrypted.
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    switch (cmd) {
      case 'check': {
        const { rows } = await client.query(`
          select (select count(*) from rounds)::int as rounds,
                 (select count(*) from injections)::int as injections,
                 (select count(*) from debate_messages)::int as messages,
                 (select count(*) from players)::int as players,
                 (select string_agg(id, ', ' order by id) from cases) as case_ids`);
        console.table(rows);
        break;
      }
      case 'cleanup': {
        await client.query('begin');
        try {
          await client.query('update games set current_round_id = null');
          const r = await client.query('delete from rounds');
          const c = await client.query('delete from cases where not (id = any($1))', [SEED_IDS]);
          await client.query('commit');
          console.log(`cleanup committed: ${r.rowCount} rounds deleted, ${c.rowCount} old cases deleted`);
        } catch (e) {
          await client.query('rollback');
          throw e;
        }
        break;
      }
      case 'apply': {
        if (!arg) throw new Error('usage: apply <file.sql>');
        const sql = readFileSync(arg, 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('commit');
          console.log(`applied ${arg}`);
        } catch (e) {
          await client.query('rollback');
          throw e;
        }
        break;
      }
      case 'reload': {
        await client.query(`notify pgrst, 'reload schema'`);
        console.log('schema reload requested');
        break;
      }
      case 'verify': {
        const { rows } = await client.query(`
          select (select count(*) from cases where used_at is null)::int as unused_cases,
                 (select count(*) from cases)::int as total_cases,
                 (select string_agg(proname, ', ' order by proname) from pg_proc
                   where pronamespace = 'public'::regnamespace
                     and proname in ('claim_ai_lease','release_ai_lease','commit_ai_step')) as rpcs,
                 has_function_privilege('service_role',
                   'public.commit_ai_step(uuid,uuid,text,int,int,jsonb,jsonb,jsonb,text)', 'execute') as svc_exec,
                 has_table_privilege('service_role', 'public.ai_round_states', 'select') as svc_select,
                 has_table_privilege('anon', 'public.ai_round_states', 'select') as anon_select`);
        console.table(rows);
        const v = rows[0];
        const ok = v.unused_cases === 6 && v.total_cases === 6 &&
          v.rpcs === 'claim_ai_lease, commit_ai_step, release_ai_lease' &&
          v.svc_exec && v.svc_select && !v.anon_select;
        console.log(ok ? 'VERIFY PASS' : 'VERIFY FAIL');
        if (!ok) process.exitCode = 1;
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd ?? '(none)'}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('ERROR:', redact(e instanceof Error ? `${e.message}${(e as { code?: string }).code ? ` [${(e as { code?: string }).code}]` : ''}` : String(e)));
  process.exit(1);
});
