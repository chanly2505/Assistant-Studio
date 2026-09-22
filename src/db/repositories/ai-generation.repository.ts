import type { AIFeature, AIGenerationStatus, Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma';

/** Arbitrary but fixed: serialises spend reservations across all instances. */
const SPEND_LOCK_KEY = 7_110_427_001n;

export interface PendingGeneration {
  userId: string;
  channelId: string | null;
  feature: AIFeature;
  provider: string;
  model: string;
  promptVersion: string;
  locale: string;
  inputHash: string;
  inputJson: Prisma.InputJsonValue;
}

/**
 * The generation record. Created PENDING *before* the provider call and
 * finalised after, so spend is recorded even if the request dies mid-flight.
 */
export const aiGenerationRepository = {
  async createPending(input: PendingGeneration): Promise<string> {
    const row = await prisma.aIGeneration.create({
      data: { ...input, status: 'PENDING' },
      select: { id: true },
    });
    return row.id;
  },

  /**
   * The spend breaker, made atomic. Creates the PENDING record with its
   * WORST-CASE cost already counted, but only if that still fits under the
   * day's cap — or returns null.
   *
   * Check-then-spend would overshoot: in-flight calls record nothing until
   * they finish, so a burst of simultaneous requests would all see the same
   * "spent so far" and all go ahead. A transaction-scoped advisory lock makes
   * the check and the reservation one step; finalize() later replaces the
   * reservation with the real cost. The lock is held for two queries.
   */
  async createPendingWithinBudget(
    input: PendingGeneration,
    budget: { since: Date; limitMicros: number; reserveMicros: number },
  ): Promise<string | null> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SPEND_LOCK_KEY})`;
      const spent = await tx.aIGeneration.aggregate({
        where: { createdAt: { gte: budget.since } },
        _sum: { costMicros: true },
      });
      if (Number(spent._sum.costMicros ?? 0n) + budget.reserveMicros > budget.limitMicros) {
        return null;
      }
      const row = await tx.aIGeneration.create({
        data: { ...input, status: 'PENDING', costMicros: BigInt(budget.reserveMicros) },
        select: { id: true },
      });
      return row.id;
    });
  },

  async finalize(
    id: string,
    result: {
      status: Exclude<AIGenerationStatus, 'PENDING'>;
      inputTokens: number;
      outputTokens: number;
      costMicros: number;
      costKnown: boolean;
      latencyMs: number;
      errorCode?: string;
      outputJson?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await prisma.aIGeneration.update({
      where: { id },
      data: {
        status: result.status,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: BigInt(result.costMicros),
        costKnown: result.costKnown,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode ?? null,
        ...(result.outputJson !== undefined ? { outputJson: result.outputJson } : {}),
        completedAt: new Date(),
      },
    });
  },

  /** A successful identical request by the same user within the window. */
  async findCached(userId: string, feature: AIFeature, inputHash: string, since: Date) {
    return prisma.aIGeneration.findFirst({
      where: { userId, feature, inputHash, status: 'OK', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, outputJson: true, model: true, promptVersion: true },
    });
  },

  /** Platform-wide spend since a moment, for the daily circuit breaker. */
  async spendSince(since: Date): Promise<number> {
    const result = await prisma.aIGeneration.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { costMicros: true },
    });
    return Number(result._sum.costMicros ?? 0n);
  },

  async findForUser(userId: string, id: string) {
    return prisma.aIGeneration.findFirst({
      where: { id, userId },
      select: {
        id: true,
        feature: true,
        status: true,
        errorCode: true,
        locale: true,
        model: true,
        promptVersion: true,
        inputJson: true,
        outputJson: true,
        channelId: true,
        createdAt: true,
        ideas: { select: { id: true, title: true } },
      },
    });
  },

  async listForUser(userId: string, limit: number) {
    return prisma.aIGeneration.findMany({
      where: { userId, status: { not: 'PENDING' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        feature: true,
        status: true,
        inputJson: true,
        createdAt: true,
        locale: true,
      },
    });
  },

  /**
   * PENDING rows older than `before` belong to a process that died mid-call.
   * Returned so the caller can refund the allowance each one reserved.
   */
  async abandoned(before: Date) {
    return prisma.aIGeneration.findMany({
      where: { status: 'PENDING', createdAt: { lt: before } },
      select: { id: true, userId: true, feature: true, createdAt: true },
      take: 500,
    });
  },

  /** Claims an abandoned row: only one sweeper can move it out of PENDING. */
  async markAbandoned(id: string): Promise<boolean> {
    const { count } = await prisma.aIGeneration.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PROVIDER_ERROR', errorCode: 'ABANDONED', completedAt: new Date() },
    });
    return count === 1;
  },
} as const;
