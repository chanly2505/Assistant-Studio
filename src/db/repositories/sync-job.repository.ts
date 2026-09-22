import type { ChannelSyncStatus, SyncJobStatus, SyncJobType } from '@prisma/client';

import { prisma } from '@/db/prisma';

/**
 * Durable history of every sync run. Redis only holds jobs until they finish;
 * this table is what support and the UI read ("last synced", "why did it fail").
 */
export const syncJobRepository = {
  async start(input: {
    channelId: string;
    jobType: SyncJobType;
    trigger: string;
    attempt: number;
  }): Promise<string> {
    const row = await prisma.syncJob.create({
      data: { ...input, status: 'RUNNING', startedAt: new Date() },
      select: { id: true },
    });
    return row.id;
  },

  async finish(
    id: string,
    result: {
      status: Extract<SyncJobStatus, 'SUCCEEDED' | 'FAILED'>;
      itemsProcessed: number;
      quotaUnitsUsed: number;
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    await prisma.syncJob.update({
      where: { id },
      data: { ...result, finishedAt: new Date() },
    });
  },

  async setChannelStatus(channelId: string, syncStatus: ChannelSyncStatus, extra: object = {}) {
    await prisma.youTubeChannel.update({
      where: { id: channelId },
      data: { syncStatus, ...extra },
    });
  },

  async recordFullSync(channelId: string, at: Date): Promise<void> {
    await prisma.youTubeChannel.update({ where: { id: channelId }, data: { lastFullSyncAt: at } });
  },

  async recordStatsSync(channelId: string, at: Date): Promise<void> {
    await prisma.youTubeChannel.update({ where: { id: channelId }, data: { lastStatsSyncAt: at } });
  },

  /** Latest successful finish time per job type, for the scheduler. */
  async lastSucceeded(
    channelIds: string[],
  ): Promise<Map<string, Partial<Record<SyncJobType, Date>>>> {
    const rows = await prisma.syncJob.groupBy({
      by: ['channelId', 'jobType'],
      where: { channelId: { in: channelIds }, status: 'SUCCEEDED' },
      _max: { finishedAt: true },
    });

    const result = new Map<string, Partial<Record<SyncJobType, Date>>>();
    for (const row of rows) {
      if (!row._max.finishedAt) continue;
      const entry = result.get(row.channelId) ?? {};
      entry[row.jobType] = row._max.finishedAt;
      result.set(row.channelId, entry);
    }
    return result;
  },

  /** Channels the scheduler may consider: connected, and on a working grant. */
  async schedulableChannels() {
    return prisma.youTubeChannel.findMany({
      where: { disconnectedAt: null, connection: { status: 'ACTIVE' } },
      select: {
        id: true,
        userId: true,
        lastFullSyncAt: true,
        lastStatsSyncAt: true,
        syncStatus: true,
      },
    });
  },
} as const;
