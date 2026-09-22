import type { AIFeature } from '@prisma/client';

import { prisma } from '@/db/prisma';

/**
 * Monthly AI allowances. The check and the increment are ONE conditional
 * UPDATE, so two simultaneous requests at the limit cannot both get through —
 * an integration test fires 20 at a limit of 5 and asserts exactly 5 succeed.
 */
export const aiUsageRepository = {
  /** Reserves one use. Returns the new count, or null when the limit is reached. */
  async reserve(
    userId: string,
    feature: AIFeature,
    periodStart: Date,
    limit: number,
  ): Promise<number | null> {
    if (limit <= 0) return null;

    await prisma.$executeRaw`
      INSERT INTO "UsageCounter" ("id", "userId", "periodStart", "feature", "count", "tokensUsed", "costMicros", "updatedAt")
      VALUES (gen_random_uuid()::text, ${userId}, ${periodStart}::date, ${feature}::"AIFeature", 0, 0, 0, now())
      ON CONFLICT ("userId", "periodStart", "feature") DO NOTHING
    `;

    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      UPDATE "UsageCounter"
      SET "count" = "count" + 1, "updatedAt" = now()
      WHERE "userId" = ${userId}
        AND "periodStart" = ${periodStart}::date
        AND "feature" = ${feature}::"AIFeature"
        AND "count" < ${limit}
      RETURNING "count"
    `;
    return rows[0]?.count ?? null;
  },

  /** Gives a reserved use back — the user did not get a result. */
  async refund(userId: string, feature: AIFeature, periodStart: Date): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "UsageCounter"
      SET "count" = "count" - 1, "updatedAt" = now()
      WHERE "userId" = ${userId}
        AND "periodStart" = ${periodStart}::date
        AND "feature" = ${feature}::"AIFeature"
        AND "count" > 0
    `;
  },

  async addSpend(
    userId: string,
    feature: AIFeature,
    periodStart: Date,
    tokens: number,
    costMicros: number,
  ): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "UsageCounter"
      SET "tokensUsed" = "tokensUsed" + ${tokens},
          "costMicros" = "costMicros" + ${costMicros},
          "updatedAt" = now()
      WHERE "userId" = ${userId}
        AND "periodStart" = ${periodStart}::date
        AND "feature" = ${feature}::"AIFeature"
    `;
  },

  async countsFor(userId: string, periodStart: Date): Promise<Partial<Record<AIFeature, number>>> {
    const rows = await prisma.usageCounter.findMany({
      where: { userId, periodStart },
      select: { feature: true, count: true },
    });
    return Object.fromEntries(rows.map((row) => [row.feature, row.count]));
  },

  async monthlyLimits(userId: string): Promise<Partial<Record<AIFeature, number>>> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: { select: { monthlyGenerations: true } } },
    });
    const raw = user.plan.monthlyGenerations;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    ) as Partial<Record<AIFeature, number>>;
  },
} as const;
