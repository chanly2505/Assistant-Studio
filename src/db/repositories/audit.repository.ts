import type { ActorType, Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@/db/prisma';

export interface AuditEntry {
  userId?: string | null;
  actorType?: ActorType;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ipHash?: string;
  userAgent?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Audit writes take an optional transaction client so a state-changing use case
 * can record the change in the same transaction that makes it. A log entry for
 * a change that rolled back is worse than no entry at all.
 *
 * docs/architecture/01-system-architecture.md §1.6
 */
type Client = PrismaClient | Prisma.TransactionClient;

export const auditRepository = {
  async record(entry: AuditEntry, client: Client = prisma): Promise<void> {
    await client.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        actorType: entry.actorType ?? 'USER',
        action: entry.action,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        ipHash: entry.ipHash ?? null,
        userAgent: entry.userAgent ?? null,
        metadata: entry.metadata ?? {},
      },
    });
  },

  async listForUser(userId: string, limit = 50) {
    return prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
} as const;
