import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@/db/prisma';

type Client = PrismaClient | Prisma.TransactionClient;

export const userRepository = {
  async planLimits(userId: string, client: Client = prisma): Promise<{ maxChannels: number }> {
    const user = await client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: { select: { maxChannels: true } } },
    });
    return { maxChannels: user.plan.maxChannels };
  },

  /** Plan feature flags (e.g. analyticsHistoryDays), as stored on the plan row. */
  async planFeatures(userId: string): Promise<Record<string, unknown>> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: { select: { features: true } } },
    });
    const features = user.plan.features;
    return features && typeof features === 'object' && !Array.isArray(features)
      ? (features as Record<string, unknown>)
      : {};
  },

  /** Called once, when Auth.js first creates the user. Idempotent. */
  async ensureSettings(userId: string): Promise<void> {
    await prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  },
} as const;
