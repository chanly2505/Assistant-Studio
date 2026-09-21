import { PrismaClient } from '@prisma/client';

import { env, config } from '@/lib/env';

/**
 * Prisma client singleton.
 *
 * Next.js dev-mode hot reload re-evaluates modules on every change; without the
 * global cache each reload opens a new pool and the database runs out of
 * connections within a few minutes.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isDevelopment ? ['warn', 'error'] : ['error'],
    datasources: { db: { url: env.DATABASE_URL } },
  });

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

export type { Prisma } from '@prisma/client';
export { PrismaClient } from '@prisma/client';

/** Readiness probe: proves the connection works, not merely that a pool exists. */
export async function checkDatabase(): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true, latencyMs: Date.now() - startedAt };
}
