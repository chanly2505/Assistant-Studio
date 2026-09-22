/**
 * Local Redis-compatible server lifecycle (Valkey or Redis), no Docker needed.
 *
 *   pnpm redis:start | redis:stop | redis:status
 *
 * Looks for `valkey-server`, then `redis-server`, on PATH and in
 * ~/.local/valkey/bin. Developers with Docker can use `docker compose up -d`
 * instead; both listen on 127.0.0.1:6379.
 *
 * `maxmemory-policy noeviction` is REQUIRED by BullMQ: with any eviction policy
 * Redis may silently drop queued jobs under memory pressure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, '.redisdata');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const PORT = 6379;

function findBinary(names: string[]): string | null {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'valkey', 'bin'),
  ];
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const server = findBinary(['valkey-server', 'redis-server']);
const cli = findBinary(['valkey-cli', 'redis-cli']);

function ping(): boolean {
  if (!cli) return false;
  const result = spawnSync(cli, ['-p', String(PORT), 'ping'], { encoding: 'utf8' });
  return result.stdout.trim() === 'PONG';
}

function start(): void {
  if (!server) {
    console.error(
      '✗ No valkey-server or redis-server found.\n' +
        '  Install Valkey (https://valkey.io) or run `docker compose up -d redis`.',
    );
    process.exit(1);
  }
  if (ping()) {
    console.log(`✓ already running on 127.0.0.1:${PORT}`);
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  execFileSync(server, [
    '--daemonize',
    'yes',
    '--port',
    String(PORT),
    '--bind',
    '127.0.0.1',
    '--protected-mode',
    'yes',
    '--dir',
    DATA_DIR,
    '--pidfile',
    PID_FILE,
    '--logfile',
    LOG_FILE,
    '--maxmemory-policy',
    'noeviction',
    // Queue state is disposable locally; skip snapshots to keep it simple.
    '--save',
    '',
    '--appendonly',
    'no',
  ]);

  for (let i = 0; i < 50 && !ping(); i += 1) spawnSync('sleep', ['0.1']);
  if (!ping()) {
    console.error(`✗ server did not answer PING. See ${path.relative(ROOT, LOG_FILE)}`);
    process.exit(1);
  }
  console.log(`✓ ${path.basename(server)} ready on 127.0.0.1:${PORT}`);
  console.log(`  REDIS_URL=redis://127.0.0.1:${PORT}`);
}

function stop(): void {
  if (!ping()) {
    console.log('✓ not running');
    return;
  }
  if (cli) spawnSync(cli, ['-p', String(PORT), 'shutdown', 'nosave']);
  else if (existsSync(PID_FILE)) process.kill(Number(readFileSync(PID_FILE, 'utf8')), 'SIGTERM');
  console.log('✓ stopped');
}

const command = process.argv[2] ?? 'start';
if (command === 'start') start();
else if (command === 'stop') stop();
else if (command === 'status') console.log(ping() ? `✓ running on ${PORT}` : '✗ not running');
else {
  console.error(`Unknown command "${command}". Use: start | stop | status`);
  process.exit(1);
}
