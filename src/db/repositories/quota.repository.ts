import type { ExternalApi } from '@prisma/client';

import { prisma } from '@/db/prisma';

/**
 * Atomic quota reservation against the project-wide daily budget.
 * docs/architecture/06-youtube-integration-architecture.md §6.2
 *
 * The check and the increment are ONE conditional UPDATE, so concurrent callers
 * cannot both pass the check with the last unit — an integration test fires 20
 * parallel reservations at a budget of 10 and asserts exactly 10 succeed.
 */

export interface Reservation {
  api: ExternalApi;
  /** YYYY-MM-DD, Pacific Time — see quotaDayKey(). */
  day: string;
  cost: number;
  dailyBudget: number;
  /** From admissionThreshold(): below this, the call is admitted. */
  threshold: number;
}

export const quotaRepository = {
  /** Returns units used after the reservation, or null when refused. */
  async reserve(reservation: Reservation): Promise<number | null> {
    const day = new Date(`${reservation.day}T00:00:00Z`);

    await prisma.$executeRaw`
      INSERT INTO "ApiQuotaLedger" ("id", "api", "day", "unitsUsed", "requestCount", "updatedAt")
      VALUES (gen_random_uuid()::text, ${reservation.api}::"ExternalApi", ${day}::date, 0, 0, now())
      ON CONFLICT ("api", "day") DO NOTHING
    `;

    const rows = await prisma.$queryRaw<Array<{ unitsUsed: bigint }>>`
      UPDATE "ApiQuotaLedger"
      SET "unitsUsed" = "unitsUsed" + ${reservation.cost},
          "requestCount" = "requestCount" + 1,
          "updatedAt" = now()
      WHERE "api" = ${reservation.api}::"ExternalApi"
        AND "day" = ${day}::date
        AND "unitsUsed" < ${reservation.threshold}
        AND "unitsUsed" + ${reservation.cost} <= ${reservation.dailyBudget}
      RETURNING "unitsUsed"
    `;

    const row = rows[0];
    return row ? Number(row.unitsUsed) : null;
  },

  async unitsUsed(api: ExternalApi, dayKey: string): Promise<number> {
    const row = await prisma.apiQuotaLedger.findUnique({
      where: { api_day: { api, day: new Date(`${dayKey}T00:00:00Z`) } },
    });
    return row ? Number(row.unitsUsed) : 0;
  },
} as const;
