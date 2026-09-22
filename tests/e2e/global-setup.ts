import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { E2E_DATABASE_URL, E2E_PORT } from '../../playwright.config';

export const AUTH_STATE = resolve(__dirname, '.auth/state.json');
export const E2E_USER_EMAIL = 'e2e@example.test';

/**
 * A clean, migrated e2e database with one signed-in user.
 *
 * Signing in through Google is not something a test can do (or should: it
 * would need a real account). The session row is created directly, exactly as
 * Auth.js would after a successful sign-in, and handed to the browser as its
 * session cookie.
 */
export default async function globalSetup() {
  const admin = new Client({ connectionString: E2E_DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = 'studio_assistant_e2e'",
    );
    if (exists.rowCount === 0) await admin.query('CREATE DATABASE "studio_assistant_e2e"');
  } finally {
    await admin.end();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: 'ignore',
  });

  const prisma = new PrismaClient({ datasourceUrl: E2E_DATABASE_URL });
  try {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    await prisma.plan.create({
      data: {
        key: 'free',
        name: 'Free',
        maxChannels: 1,
        monthlyGenerations: { IDEAS: 50, TITLES: 50, DESCRIPTION: 25, SCRIPT: 5, PLAN: 5 },
      },
    });
    const user = await prisma.user.create({
      data: { email: E2E_USER_EMAIL, name: 'E2E', settings: { create: {} } },
    });
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 2 * 3_600_000);
    await prisma.session.create({ data: { sessionToken: token, userId: user.id, expires } });

    mkdirSync(resolve(__dirname, '.auth'), { recursive: true });
    writeFileSync(
      AUTH_STATE,
      JSON.stringify({
        cookies: [
          {
            name: 'ysa.session',
            value: token,
            domain: 'localhost',
            path: '/',
            expires: Math.floor(expires.getTime() / 1000),
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [{ origin: `http://localhost:${E2E_PORT}`, localStorage: [] }],
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}
