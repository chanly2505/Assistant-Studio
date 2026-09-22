/**
 * Local backup and a REHEARSED restore. docs/architecture/10 §10.7
 *
 *   pnpm db:backup                 → backups/<timestamp>/ (one JSON file per table)
 *   pnpm db:restore-check [<dir>]  → restore into a scratch database and prove
 *                                    every table matches, then drop the scratch
 *
 * "An untested backup is a hypothesis." This is the test: the schema is rebuilt
 * from the project's own migrations (the source of truth), the rows are loaded
 * back, and each table's row count AND a checksum over every row must equal the
 * source. Any difference fails loudly.
 *
 * Production uses the database provider's point-in-time recovery instead; this
 * rehearses the same promise on a developer machine, and is the procedure to
 * run against a PITR restore to verify it.
 *
 * Not in the backup, by design: TOKEN_ENCRYPTION_KEY. It is backed up
 * separately, in a different place — a backup that holds both the encrypted
 * tokens and the key defeats the encryption (§10.7).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import pg from 'pg';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'postgresql://postgres:postgres@127.0.0.1:5433';
const SOURCE_DB = process.env.BACKUP_SOURCE_DB ?? 'studio_assistant';
const SCRATCH_DB = 'studio_assistant_restore_check';
const BATCH = 500;

async function connect(database: string) {
  const client = new pg.Client({ connectionString: `${BASE}/${database}` });
  await client.connect();
  return client;
}

async function tables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename",
  );
  return rows.map((r) => r.tablename);
}

/** Row count and an order-independent checksum over every row's JSON form. */
async function fingerprint(client: pg.Client, table: string) {
  const { rows } = await client.query<{ count: string; checksum: string | null }>(
    `SELECT count(*)::text AS count,
            md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '')) AS checksum
       FROM "${table}" t`,
  );
  return { rows: Number(rows[0]?.count ?? 0), checksum: rows[0]?.checksum ?? '' };
}

async function backup(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'backups', stamp);
  mkdirSync(dir, { recursive: true });
  const client = await connect(SOURCE_DB);
  try {
    // One consistent snapshot for every table.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const manifest: Record<string, { rows: number; checksum: string }> = {};
    for (const table of await tables(client)) {
      const { rows } = await client.query(`SELECT row_to_json(t) AS row FROM "${table}" t`);
      writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(rows.map((r) => r.row)));
      manifest[table] = await fingerprint(client, table);
    }
    const migrations = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
    );
    await client.query('COMMIT');
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        {
          source: SOURCE_DB,
          takenAt: new Date().toISOString(),
          migrations: migrations.rows.map((r) => r.migration_name),
          tables: manifest,
        },
        null,
        2,
      ),
    );
    const total = Object.values(manifest).reduce((n, t) => n + t.rows, 0);
    console.log(
      `✓ backup of ${SOURCE_DB}: ${Object.keys(manifest).length} tables, ${total} rows → ${path.relative(ROOT, dir)}`,
    );
    return dir;
  } finally {
    await client.end();
  }
}

async function restoreCheck(dir: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    migrations: string[];
    tables: Record<string, { rows: number; checksum: string }>;
  };

  const admin = await connect('postgres');
  await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  await admin.end();

  try {
    // 1. Schema from the migrations, exactly as a deploy would build it.
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: `${BASE}/${SCRATCH_DB}` },
      stdio: 'ignore',
    });

    const client = await connect(SCRATCH_DB);
    try {
      const applied = await client.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
      );
      const missing = manifest.migrations.filter(
        (m) => !applied.rows.some((r) => r.migration_name === m),
      );
      if (missing.length) throw new Error(`restore is missing migrations: ${missing.join(', ')}`);

      // 2. Rows. Foreign keys are enforced again the moment the load ends;
      //    during it they are deferred so table order does not matter.
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      // Some migrations insert reference rows (the plans). The backup holds the
      // real ones, so start every table empty rather than colliding with them.
      const restoreTables = await tables(client);
      if (restoreTables.length) {
        await client.query(`TRUNCATE ${restoreTables.map((t) => `"${t}"`).join(', ')} CASCADE`);
      }
      for (const table of Object.keys(manifest.tables)) {
        const rows = JSON.parse(readFileSync(path.join(dir, `${table}.json`), 'utf8')) as unknown[];
        for (let i = 0; i < rows.length; i += BATCH) {
          await client.query(
            `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json)`,
            [JSON.stringify(rows.slice(i, i + BATCH))],
          );
        }
      }
      await client.query('COMMIT');

      // 3. Proof.
      const problems: string[] = [];
      let total = 0;
      for (const [table, expected] of Object.entries(manifest.tables)) {
        const actual = await fingerprint(client, table);
        total += actual.rows;
        if (actual.rows !== expected.rows || actual.checksum !== expected.checksum) {
          problems.push(
            `${table}: expected ${expected.rows} rows/${expected.checksum}, got ${actual.rows}/${actual.checksum}`,
          );
        }
      }
      const unexpected = (await tables(client)).filter((t) => !(t in manifest.tables));
      if (unexpected.length) problems.push(`tables not in the backup: ${unexpected.join(', ')}`);

      if (problems.length) {
        console.error(`✗ restore check FAILED:\n  ${problems.join('\n  ')}`);
        process.exitCode = 1;
      } else {
        console.log(
          `✓ restore check passed: ${Object.keys(manifest.tables).length} tables, ${total} rows, every checksum identical`,
        );
      }
    } finally {
      await client.end();
    }
  } finally {
    const cleanup = await connect('postgres');
    await cleanup.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await cleanup.end();
  }
}

function latestBackup(): string {
  const dir = path.join(ROOT, 'backups');
  const all = readdirSync(dir)
    .filter((d) => !d.startsWith('.'))
    .sort();
  const last = all.at(-1);
  if (!last) throw new Error('no backups yet — run pnpm db:backup first');
  return path.join(dir, last);
}

const [command, argument] = process.argv.slice(2);
if (command === 'backup') await backup();
else if (command === 'restore-check')
  await restoreCheck(argument ? path.resolve(argument) : latestBackup());
else if (command === 'rehearse') await restoreCheck(await backup());
else {
  console.error('usage: backup | restore-check [dir] | rehearse');
  process.exitCode = 2;
}
