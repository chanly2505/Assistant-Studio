import type { Logger } from 'pino';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { channelRepository } from '@/db/repositories/channel.repository';
import { connectionRepository } from '@/db/repositories/connection.repository';
import { notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import { logger as rootLogger } from '@/lib/logger';
import { getTokenVault } from '@/services/crypto';
import { revokeToken } from '@/services/google/oauth';
import { evictAccessToken } from '@/modules/youtube/access-token';

/**
 * Disconnect a channel.
 * docs/architecture/05-authentication-architecture.md §5.4
 *
 * - Revokes the grant AT GOOGLE, not just locally. Leaving a live grant behind
 *   after a user asked to disconnect is a trust violation.
 * - Keeps the channel's history (videos, analytics). Reconnecting the same
 *   channel resumes from it instead of re-backfilling.
 * - The refresh-token ciphertext is wiped whatever happens upstream. If Google
 *   is unreachable, the user is told to remove access themselves — the app can
 *   no longer use the grant either way.
 *
 * Nuance worth knowing: Google tracks one grant per (Google account, OAuth
 * client). If the account used to connect this channel is ALSO the one the user
 * signs in with, revoking here clears that account's consent for sign-in too.
 * The user stays signed in (sessions are ours), but their next sign-in shows
 * Google's consent screen again. Brand-account channels have their own Google
 * identity, so they are unaffected.
 */

export type RevocationOutcome = 'revoked' | 'already_invalid' | 'failed' | 'not_needed';

export async function disconnectChannel(input: {
  userId: string;
  channelId: string;
  log?: Logger;
}): Promise<Result<{ revocation: RevocationOutcome }>> {
  const log = input.log ?? rootLogger;

  const channel = await channelRepository.findForUser(input.userId, input.channelId);
  if (!channel || channel.disconnectedAt) return err(notFound('channel'));

  const connection = await connectionRepository.findForUser(input.userId, channel.connectionId);
  const others = await channelRepository.countActiveOnConnection(
    input.userId,
    channel.connectionId,
  );
  // Revoke only when this is the last channel riding on the grant.
  const shouldRevoke = connection !== null && connection.status !== 'REVOKED' && others <= 1;

  let revocation: RevocationOutcome = 'not_needed';
  if (shouldRevoke && connection.encryptedRefreshToken) {
    try {
      const refreshToken = getTokenVault().decrypt(
        connection.encryptedRefreshToken,
        connection.id,
        'refreshToken',
      );
      revocation = await revokeToken(refreshToken, log);
    } catch (error) {
      revocation = 'failed';
      log.warn(
        { err: { errorCode: toAppError(error).code }, connectionId: connection.id },
        'upstream revocation failed; wiping local grant anyway',
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await channelRepository.markDisconnected(input.userId, channel.id, tx);
    if (shouldRevoke)
      await connectionRepository.markRevoked(input.userId, channel.connectionId, tx);
    await auditRepository.record(
      {
        userId: input.userId,
        action: 'youtube.channel.disconnected',
        resourceType: 'YouTubeChannel',
        resourceId: channel.id,
        metadata: { revocation },
      },
      tx,
    );
  });

  if (shouldRevoke) evictAccessToken(channel.connectionId);

  return ok({ revocation });
}
