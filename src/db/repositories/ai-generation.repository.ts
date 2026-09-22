import type { AIFeature, AIGenerationStatus, Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma';

/**
 * The generation record. Created PENDING *before* the provider call and
 * finalised after, so spend is recorded even if the request dies mid-flight.
 */
export const aiGenerationRepository = {
  async createPending(input: {
    userId: string;
    channelId: string | null;
    feature: AIFeature;
    provider: string;
    model: string;
    promptVersion: string;
    locale: string;
    inputHash: string;
    inputJson: Prisma.InputJsonValue;
  }): Promise<string> {
    const row = await prisma.aIGeneration.create({
      data: { ...input, status: 'PENDING' },
      select: { id: true },
    });
    return row.id;
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
