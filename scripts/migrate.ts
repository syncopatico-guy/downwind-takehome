/**
 * Migration runner.
 *
 * Applies db/migrations/*.sql in filename order, tracking applied files in a
 * _migrations table. Each file runs in its own transaction, so a failure
 * leaves earlier migrations applied and the failing one fully rolled back.
 *
 *   npm run migrate          apply pending migrations
 *   npm run migrate -- --status   show what is applied without changing anything
 *
 * psql is not installed on the build machine, so migrations run through Node.
 * That is also more portable for CI.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from 'dotenv';
import { getPool, closePool, query } from '../lib/db';

config({ path: '.env.local', quiet: true });
config({ quiet: true });

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

interface AppliedRow { filename: string; checksum: string; applied_at: Date }

async function ensureTrackingTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   text PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function discoverMigrations(): { filename: string; sql: string; checksum: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return {
        filename,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      };
    });
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');

  await ensureTrackingTable();

  const applied = new Map(
    (await query<AppliedRow>('SELECT filename, checksum, applied_at FROM _migrations'))
      .map((r) => [r.filename, r]),
  );
  const migrations = discoverMigrations();

  if (migrations.length === 0) {
    console.log('no migration files found in db/migrations');
    return;
  }

  if (statusOnly) {
    console.log('\nmigration status\n');
    for (const m of migrations) {
      const row = applied.get(m.filename);
      if (!row) {
        console.log(`  PENDING   ${m.filename}`);
      } else if (row.checksum !== m.checksum) {
        // A migration that changed after being applied is a real hazard: the
        // database no longer matches the file. Flag loudly rather than
        // silently skipping.
        console.log(`  MODIFIED  ${m.filename}  (applied ${row.checksum}, on disk ${m.checksum})`);
      } else {
        console.log(`  applied   ${m.filename}  ${row.applied_at.toISOString()}`);
      }
    }
    console.log('');
    return;
  }

  let ran = 0;
  const pool = getPool();

  for (const m of migrations) {
    const row = applied.get(m.filename);

    if (row) {
      if (row.checksum !== m.checksum) {
        console.warn(
          `  ! ${m.filename} has changed since it was applied ` +
            `(applied ${row.checksum}, on disk ${m.checksum}) — skipping. ` +
            `Add a new migration rather than editing an applied one.`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)',
        [m.filename, m.checksum],
      );
      await client.query('COMMIT');
      console.log(`  applied  ${m.filename}  (${Date.now() - started} ms)`);
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\nFAILED   ${m.filename}\n`);
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
      return;
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? '  nothing to apply — schema up to date' : `\n${ran} migration(s) applied`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
