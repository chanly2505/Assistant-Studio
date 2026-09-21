import type { ConnectionStatus, Prisma, PrismaClient, YouTubeChannel } from '@prisma/client';

import { prisma } from '@/db/prisma';

/**
 * Every read method takes a proven `userId` and puts it in the WHERE clause.
 *
 * There is deliberately no `findById(id)`: a method that can return another
 * user's row is an IDOR waiting to happen, so it does not exist.
 * `tests/integration/repositories/scoping.test.ts` asserts this.
 *
 * The single cross-user method, `ownerOf`, returns an owner id and nothing else;
 * it exists to detect "this channel is already connected to another account"
 * without exposing that account's data.
 *
 * docs/architecture/05-authentication-architecture.md §5.5
 */

type Client = PrismaClient | Prisma.TransactionClient;

export interface ListChannelsFilter {
  includeDisconnected?: boolean;
}

export type ChannelWithConnection = YouTubeChannel & {
  connection: { status: ConnectionStatus };
  statsSnapshots: Array<{
    subscriberCount: bigint | null;
    viewCount: bigint;
    videoCount: number;
    capturedAt: Date;
  }>;
};

export interface ChannelUpsert {
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  country: string | null;
  uploadsPlaylistId: string;
  publishedAt: Date | null;
}

export const channelRepository = {
  async listForUser(
    userId: string,
    filter: ListChannelsFilter = {},
  ): Promise<ChannelWithConnection[]> {
    return prisma.youTubeChannel.findMany({
      where: {
        userId,
        ...(filter.includeDisconnected ? {} : { disconnectedAt: null }),
      },
      include: {
        connection: { select: { status: true } },
        // Latest snapshot only — the list shows current figures, not history.
        statsSnapshots: {
          select: { subscriberCount: true, viewCount: true, videoCount: true, capturedAt: true },
          orderBy: { capturedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { connectedAt: 'asc' },
    });
  },

  async findForUser(userId: string, channelId: string): Promise<YouTubeChannel | null> {
    return prisma.youTubeChannel.findFirst({
      where: { id: channelId, userId },
    });
  },

  async findByYouTubeId(userId: string, youtubeChannelId: string): Promise<YouTubeChannel | null> {
    return prisma.youTubeChannel.findFirst({
      where: { youtubeChannelId, userId },
    });
  },

  async countForUser(userId: string): Promise<number> {
    return prisma.youTubeChannel.count({
      where: { userId, disconnectedAt: null },
    });
  },

  /** Owner id of a YouTube channel, or null. Returns no channel data. */
  async ownerOf(youtubeChannelId: string, client: Client = prisma): Promise<string | null> {
    const row = await client.youTubeChannel.findUnique({
      where: { youtubeChannelId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  },

  /**
   * Creates the channel, or re-attaches a previously disconnected one to its new
   * grant. Reusing the row keeps its history and `lastAnalyticsDate`, so a
   * reconnect resumes rather than paying for a full backfill again.
   */
  async attach(
    userId: string,
    connectionId: string,
    channel: ChannelUpsert,
    client: Client = prisma,
  ): Promise<{ channel: YouTubeChannel; reattached: boolean }> {
    const existing = await client.youTubeChannel.findUnique({
      where: { youtubeChannelId: channel.youtubeChannelId },
    });

    if (existing && existing.userId !== userId) {
      // Callers check ownerOf() first; this guards the invariant regardless.
      throw new Error('attach(): channel belongs to another user');
    }

    if (existing) {
      const updated = await client.youTubeChannel.update({
        where: { id: existing.id },
        data: { ...channel, connectionId, disconnectedAt: null, connectedAt: new Date() },
      });
      return { channel: updated, reattached: true };
    }

    const created = await client.youTubeChannel.create({
      data: {
        ...channel,
        userId,
        connectionId,
        settings: { create: {} },
      },
    });
    return { channel: created, reattached: false };
  },

  async countActiveOnConnection(
    userId: string,
    connectionId: string,
    client: Client = prisma,
  ): Promise<number> {
    return client.youTubeChannel.count({
      where: { userId, connectionId, disconnectedAt: null },
    });
  },

  async markDisconnected(
    userId: string,
    channelId: string,
    client: Client = prisma,
  ): Promise<void> {
    await client.youTubeChannel.updateMany({
      where: { id: channelId, userId },
      data: { disconnectedAt: new Date(), syncStatus: 'PAUSED' },
    });
  },
} as const;
