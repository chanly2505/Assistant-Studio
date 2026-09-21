import { PrismaClient } from '@prisma/client';

/**
 * Integration-test database helpers.
 *
 * Prisma is NOT mocked anywhere in this suite. A mocked ORM tests the mock —
 * it cannot catch a bad index, a cascade rule that deletes too much, or a
 * unique constraint that does not hold. docs/architecture/09 §9.2
 */

export const testPrisma = new PrismaClient();

/**
 * Tables in dependency order is fragile to maintain, so this discovers them and
 * truncates with CASCADE in a single statement.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await testPrisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(', ');
  await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function disconnectDatabase(): Promise<void> {
  await testPrisma.$disconnect();
}

let userCounter = 0;

/** Creates a user with the plan row it depends on. */
export async function createTestUser(overrides: { email?: string; planKey?: string } = {}) {
  const planKey = overrides.planKey ?? 'free';

  await testPrisma.plan.upsert({
    where: { key: planKey },
    update: {},
    create: {
      key: planKey,
      name: planKey,
      maxChannels: 1,
      monthlyGenerations: { IDEAS: 50, TITLES: 50, DESCRIPTION: 25, SCRIPT: 5, PLAN: 5 },
    },
  });

  userCounter += 1;

  return testPrisma.user.create({
    data: {
      email: overrides.email ?? `user-${userCounter}-${Date.now()}@example.test`,
      name: `Test User ${userCounter}`,
      planKey,
    },
  });
}

/** Creates a connection + channel pair owned by `userId`. */
export async function createTestChannel(userId: string, overrides: { title?: string } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const connection = await testPrisma.youTubeConnection.create({
    data: {
      userId,
      googleSub: `sub-${suffix}`,
      googleEmail: `google-${suffix}@example.test`,
      encryptedRefreshToken: 'v1:ciphertext-placeholder',
      scopes: [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ],
    },
  });

  return testPrisma.youTubeChannel.create({
    data: {
      connectionId: connection.id,
      userId,
      youtubeChannelId: `UC${suffix}`,
      title: overrides.title ?? `Channel ${suffix}`,
      uploadsPlaylistId: `UU${suffix}`,
    },
  });
}
