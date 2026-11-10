import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { getConfig, getSecret, requireSecret } from '@/config/env';

/**
 * npm run db:migrate — applies supabase/migrations/*.sql in order.
 * Uses POSTGRES_URL_NON_POOLING when set (better for DDL), otherwise POSTGRES_URL.
 * With --if-configured (used by the Vercel build) it does nothing unless STORAGE_PROVIDER=supabase.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--if-configured') && (getConfig('STORAGE_PROVIDER') !== 'supabase' || !getSecret('POSTGRES_URL'))) {
    console.log('Storage is not Supabase: no migration to apply.');
    return;
  }
  const url = getSecret('POSTGRES_URL_NON_POOLING') ?? requireSecret('POSTGRES_URL');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, ...(local ? {} : { ssl: 'require' as const }) });
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    await sql`alter table schema_migrations enable row level security`;
    const dir = path.join(process.cwd(), 'supabase', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const done = await sql`select 1 from schema_migrations where name = ${file}`;
      if (done.length) {
        console.log(`skip  ${file}`);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(path.join(dir, file), 'utf8'));
        await tx`insert into schema_migrations (name) values (${file})`;
      });
      console.log(`apply ${file}`);
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}
main().catch((e) => {
  console.error('Migration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
