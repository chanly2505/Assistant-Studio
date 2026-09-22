/**
 * Local PostgreSQL 16 lifecycle, with no Docker and no sudo.
 *
 * Uses the real PostgreSQL binaries vendored by `embedded-postgres`, driven
 * through `pg_ctl` so the server daemonises and survives this script exiting.
 *
 * Team members who have Docker should use `docker compose up -d` instead —
 * see docker-compose.yml. Both produce the same connection string.
 *
 *   pnpm db:start | db:stop | db:status | db:nuke
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, '.pgdata');
const LOG_FILE = path.join(DATA_DIR, 'server.log');

const PORT = 5433;
const USER = 'postgres';
const PASSWORD = 'postgres';
// dev, unit/integration tests (truncated by every run), and the e2e browser tests.
const DATABASES = ['studio_assistant', 'studio_assistant_test', 'studio_assistant_e2e'];

function binDir(): string {
  const require = createRequire(import.meta.url);
  // Resolve the platform package from inside embedded-postgres so pnpm's nested
  // node_modules layout is respected.
  const embeddedEntry = require.resolve('embedded-postgres');
  const platformPkg = `@embedded-postgres/${os.platform()}-${os.arch()}`;
  const platformEntry = createRequire(embeddedEntry).resolve(platformPkg);
  return path.resolve(path.dirname(platformEntry), '..', 'native', 'bin');
}

const bin = (name: string) => path.join(binDir(), name);

function isRunning(): boolean {
  const result = spawnSync(bin('pg_ctl'), ['-D', DATA_DIR, 'status'], { encoding: 'utf8' });
  return result.status === 0;
}

function initialise(): void {
  if (existsSync(path.join(DATA_DIR, 'PG_VERSION'))) return;

  console.log('→ initialising a fresh cluster in .pgdata');
  mkdirSync(DATA_DIR, { recursive: true });

  const pwFile = path.join(os.tmpdir(), `ysa-pw-${process.pid}`);
  writeFileSync(pwFile, PASSWORD, { mode: 0o600 });
  try {
    execFileSync(
      bin('initdb'),
      [
        '-D',
        DATA_DIR,
        '-U',
        USER,
        '--auth=scram-sha-256',
        `--pwfile=${pwFile}`,
        '--encoding=UTF8',
        '--locale=C',
      ],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(pwFile, { force: true });
  }

  // Bind to loopback only. This cluster is for local development.
  writeFileSync(
    path.join(DATA_DIR, 'postgresql.auto.conf'),
    [`port = ${PORT}`, "listen_addresses = '127.0.0.1'", 'max_connections = 100', ''].join('\n'),
  );
}

async function ensureDatabases(): Promise<void> {
  const client = new Client({
    host: '127.0.0.1',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    for (const name of DATABASES) {
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        name,
      ]);
      if (rowCount === 0) {
        // Identifier cannot be parameterised; the values are hard-coded above.
        await client.query(`CREATE DATABASE "${name}"`);
        console.log(`→ created database ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function waitForReady(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({
      host: '127.0.0.1',
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: 'postgres',
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(`PostgreSQL did not become ready in ${timeoutMs}ms: ${String(lastError)}`);
}

async function start(): Promise<void> {
  initialise();

  if (isRunning()) {
    console.log(`✓ PostgreSQL already running on port ${PORT}`);
  } else {
    console.log('→ starting PostgreSQL');
    execFileSync(bin('pg_ctl'), ['-D', DATA_DIR, '-l', LOG_FILE, '-w', 'start'], {
      stdio: 'inherit',
    });
  }

  await waitForReady();
  await ensureDatabases();

  console.log(`\n✓ PostgreSQL 16 ready on 127.0.0.1:${PORT}`);
  console.log(`  DATABASE_URL=postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASES[0]}`);
  console.log(`  logs: ${path.relative(ROOT, LOG_FILE)}`);
}

function stop(): void {
  if (!isRunning()) {
    console.log('✓ PostgreSQL is not running');
    return;
  }
  execFileSync(bin('pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit' });
  console.log('✓ stopped');
}

function status(): void {
  console.log(isRunning() ? `✓ running on port ${PORT}` : '✗ not running');
}

function nuke(): void {
  if (isRunning()) stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('✓ removed .pgdata — run `pnpm db:start` to recreate');
}

const command = process.argv[2] ?? 'start';

try {
  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      stop();
      break;
    case 'status':
      status();
      break;
    case 'nuke':
      nuke();
      break;
    default:
      console.error(`Unknown command "${command}". Use: start | stop | status | nuke`);
      process.exit(1);
  }
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  if (existsSync(LOG_FILE)) console.error(`  See ${path.relative(ROOT, LOG_FILE)} for details.`);
  process.exit(1);
}
