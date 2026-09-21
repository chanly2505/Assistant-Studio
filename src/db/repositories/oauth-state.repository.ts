import type { OAuthState } from '@prisma/client';

import { prisma } from '@/db/prisma';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const oauthStateRepository = {
  async create(input: { state: string; userId: string; codeVerifier: string }): Promise<void> {
    await prisma.oAuthState.create({
      data: {
        state: input.state,
        userId: input.userId,
        codeVerifier: input.codeVerifier,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });
  },

  /**
   * Single-use by construction: the row is DELETEd and returned in one
   * statement. Two concurrent callbacks with the same state cannot both get it —
   * the second finds nothing. A replayed callback URL is therefore worthless.
   */
  async consume(state: string): Promise<OAuthState | null> {
    const rows = await prisma.$queryRaw<OAuthState[]>`
      DELETE FROM "OAuthState" WHERE "state" = ${state} RETURNING *
    `;
    return rows[0] ?? null;
  },

  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
    return count;
  },
} as const;
