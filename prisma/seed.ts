import { PrismaClient } from '@prisma/client';

/**
 * Deterministic development data.
 *
 * Plans are reference data and belong in every environment — the `User.planKey`
 * foreign key means no user can be created without them. The scenario users are
 * development-only, so the seed refuses to run against a production database.
 *
 * docs/architecture/09-testing-strategy.md §9.6
 */

const prisma = new PrismaClient();

const PLANS = [
  {
    key: 'free',
    name: 'Free',
    maxChannels: 1,
    monthlyGenerations: { IDEAS: 20, TITLES: 20, DESCRIPTION: 10, SCRIPT: 2, PLAN: 2 },
    features: { analyticsHistoryDays: 90 },
  },
  {
    key: 'creator',
    name: 'Creator',
    maxChannels: 3,
    monthlyGenerations: { IDEAS: 300, TITLES: 300, DESCRIPTION: 150, SCRIPT: 30, PLAN: 30 },
    features: { analyticsHistoryDays: 365 },
  },
  {
    key: 'studio',
    name: 'Studio',
    maxChannels: 10,
    monthlyGenerations: { IDEAS: 2000, TITLES: 2000, DESCRIPTION: 1000, SCRIPT: 200, PLAN: 200 },
    features: { analyticsHistoryDays: 365, prioritySync: true },
  },
];

async function seedPlans(): Promise<void> {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { key: plan.key },
      update: {
        name: plan.name,
        maxChannels: plan.maxChannels,
        monthlyGenerations: plan.monthlyGenerations,
        features: plan.features,
      },
      create: plan,
    });
  }
  console.log(`✓ ${PLANS.length} plans`);
}

async function seedDevelopmentUsers(): Promise<void> {
  // A user with nothing connected — the empty state most new users land on.
  const newUser = await prisma.user.upsert({
    where: { email: 'new@example.test' },
    update: {},
    create: {
      email: 'new@example.test',
      name: 'New Creator',
      planKey: 'free',
      settings: { create: { onboardingStep: 'connect_channel' } },
    },
  });

  // A user with a connected channel, so channel-scoped screens have data.
  const activeUser = await prisma.user.upsert({
    where: { email: 'active@example.test' },
    update: {},
    create: {
      email: 'active@example.test',
      name: 'Active Creator',
      planKey: 'creator',
      settings: { create: { onboardingStep: 'done', contentLanguage: 'en' } },
    },
  });

  const connection = await prisma.youTubeConnection.upsert({
    where: { userId_googleSub: { userId: activeUser.id, googleSub: 'dev-sub-active' } },
    // Also corrects rows seeded by older versions of this file.
    update: { encryptedRefreshToken: '', status: 'REAUTH_REQUIRED' },
    create: {
      userId: activeUser.id,
      googleSub: 'dev-sub-active',
      googleEmail: 'active@example.test',
      // Not a real grant, so the connection is seeded as REAUTH_REQUIRED: the UI
      // shows "Reconnect" and the scheduler never tries to sync it. Connect a
      // real channel from the Channels page to exercise sync.
      encryptedRefreshToken: '',
      status: 'REAUTH_REQUIRED',
      scopes: [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ],
    },
  });

  await prisma.youTubeChannel.upsert({
    where: { youtubeChannelId: 'UCdev0000000000000000001' },
    update: {},
    create: {
      connectionId: connection.id,
      userId: activeUser.id,
      youtubeChannelId: 'UCdev0000000000000000001',
      title: 'Phnom Penh Street Food',
      handle: '@ppstreetfood',
      uploadsPlaylistId: 'UUdev0000000000000000001',
      syncStatus: 'NEVER_SYNCED',
      settings: {
        create: {
          niche: 'Food and travel',
          targetAudience: 'Locals and visitors looking for authentic Cambodian food',
          keywords: ['street food', 'phnom penh', 'cambodia'],
          contentLanguage: 'en',
        },
      },
    },
  });

  console.log(`✓ development users: ${newUser.email}, ${activeUser.email}`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';

  await seedPlans();

  if (process.env.NODE_ENV === 'production') {
    console.log('· production: skipping development users');
    return;
  }

  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.log('· non-local database: skipping development users');
    return;
  }

  await seedDevelopmentUsers();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
