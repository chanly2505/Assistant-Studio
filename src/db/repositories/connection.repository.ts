import type { Prisma, PrismaClient, YouTubeConnection } from '@prisma/client';

import { prisma } from '@/db/prisma';

/**
 * YouTube OAuth grants. Every method takes the owning userId.
 *
 * `encryptedRefreshToken` never leaves this module in plaintext form — it is
 * ciphertext here and only the application layer, holding the vault, can open
 * it. It is also never selected into anything returned to a route.
 */

type Client = PrismaClient | Prisma.TransactionClient;

export const connectionRepository = {
  async findForUser(userId: string, connectionId: string): Promise<YouTubeConnection | null> {
    return prisma.youTubeConnection.findFirst({ where: { id: connectionId, userId } });
  },

  async findByGoogleSub(
    userId: string,
    googleSub: string,
    client: Client = prisma,
  ): Promise<YouTubeConnection | null> {
    return client.youTubeConnection.findUnique({
      where: { userId_googleSub: { userId, googleSub } },
    });
  },

  async save(
    input: {
      id: string;
      userId: string;
      googleSub: string;
      googleEmail: string;
      encryptedRefreshToken: string;
      encryptionKeyVersion: number;
      scopes: string[];
    },
    client: Client = prisma,
  ): Promise<YouTubeConnection> {
    const fresh = {
      googleEmail: input.googleEmail,
      encryptedRefreshToken: input.encryptedRefreshToken,
      encryptionKeyVersion: input.encryptionKeyVersion,
      scopes: input.scopes,
      status: 'ACTIVE' as const,
      grantedAt: new Date(),
      lastRefreshError: null,
      revokedAt: null,
    };

    return client.youTubeConnection.upsert({
      where: { userId_googleSub: { userId: input.userId, googleSub: input.googleSub } },
      create: { id: input.id, userId: input.userId, googleSub: input.googleSub, ...fresh },
      update: fresh,
    });
  },

  async recordRefresh(userId: string, connectionId: string): Promise<void> {
    await prisma.youTubeConnection.updateMany({
      where: { id: connectionId, userId },
      data: { lastRefreshedAt: new Date(), lastRefreshError: null },
    });
  },

  async rotateCiphertext(
    userId: string,
    connectionId: string,
    encryptedRefreshToken: string,
    encryptionKeyVersion: number,
  ): Promise<void> {
    await prisma.youTubeConnection.updateMany({
      where: { id: connectionId, userId },
      data: { encryptedRefreshToken, encryptionKeyVersion },
    });
  },

  async markReauthRequired(userId: string, connectionId: string, reason: string): Promise<void> {
    await prisma.youTubeConnection.updateMany({
      where: { id: connectionId, userId, status: 'ACTIVE' },
      data: { status: 'REAUTH_REQUIRED', lastRefreshError: reason },
    });
  },

  /** Wipes the ciphertext: a revoked grant keeps no usable secret behind. */
  async markRevoked(userId: string, connectionId: string, client: Client = prisma): Promise<void> {
    await client.youTubeConnection.updateMany({
      where: { id: connectionId, userId },
      data: { status: 'REVOKED', revokedAt: new Date(), encryptedRefreshToken: '' },
    });
  },
} as const;
