import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { channelRepository } from '@/db/repositories/channel.repository';
import { connectionRepository } from '@/db/repositories/connection.repository';
import { oauthStateRepository } from '@/db/repositories/oauth-state.repository';
import { userRepository } from '@/db/repositories/user.repository';
import { AppError, conflict, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import { missingScopes } from '@/domain/youtube/scopes';
import { logger as rootLogger } from '@/lib/logger';
import { getTokenVault } from '@/services/crypto';
import {
  exchangeAuthorizationCode,
  revokeToken,
  type ExchangedTokens,
} from '@/services/google/oauth';
import { getYouTubeService } from '@/services/youtube/youtube.service';

import { enqueueInitialSync } from '@/modules/sync/schedule';

import { primeAccessToken } from './access-token';
import { reserveYouTubeQuota } from './quota-guard';

/**
 * Step 2 of the channel-connect grant: Google's redirect back to us.
 * docs/architecture/05-authentication-architecture.md §5.3
 *
 * Invariant: either the whole connection is stored — encrypted grant, channel
 * rows, first stats snapshot, audit entry — or nothing is, and the fresh Google
 * grant is revoked so no live credential is left dangling.
 */

export interface CompleteChannelConnectInput {
  sessionUserId: string;
  code?: string | undefined;
  state?: string | undefined;
  /** Google's `error` parameter, e.g. `access_denied` when the user cancels. */
  error?: string | undefined;
  log?: Logger;
}

export interface CompletedConnection {
  connectionId: string;
  channels: Array<{ id: string; title: string; reattached: boolean }>;
}

export async function completeChannelConnect(
  input: CompleteChannelConnectInput,
): Promise<Result<CompletedConnection>> {
  const log = input.log ?? rootLogger;

  /* 1. State: exists, single-use, unexpired, and bound to THIS user. --------- */
  // Consumed before anything else — including on the cancel path — so a state
  // value can never be used twice.
  const state = input.state ? await oauthStateRepository.consume(input.state) : null;

  if (input.error) {
    return err(
      new AppError(input.error === 'access_denied' ? 'OAUTH_DENIED' : 'OAUTH_FAILED', {
        detail: `google returned error=${input.error}`,
      }),
    );
  }

  if (!state || !input.code) {
    return err(new AppError('OAUTH_STATE_INVALID', { detail: 'state missing, unknown or reused' }));
  }
  if (state.expiresAt <= new Date()) {
    return err(new AppError('OAUTH_STATE_INVALID', { detail: 'state expired' }));
  }
  if (state.userId !== input.sessionUserId) {
    // Someone completed a consent flow started by a different account. This is
    // the grant-injection attack: an attacker's channel attached to a victim.
    await auditRepository.record({
      userId: input.sessionUserId,
      action: 'youtube.connect.state_user_mismatch',
      metadata: { severity: 'security' },
    });
    return err(new AppError('OAUTH_STATE_INVALID', { detail: 'state belongs to another user' }));
  }

  /* 2. Exchange the code. Nothing is stored yet. ------------------------------ */
  let tokens: ExchangedTokens;
  try {
    tokens = await exchangeAuthorizationCode({
      code: input.code,
      codeVerifier: state.codeVerifier,
      log,
    });
  } catch (error) {
    return err(toAppError(error));
  }

  /* 3. From here on, any failure revokes the grant we just received. --------- */
  try {
    return ok(await persistConnection(input.sessionUserId, tokens, log));
  } catch (error) {
    await revokeQuietly(tokens, log);
    return err(toAppError(error));
  }
}

async function persistConnection(
  userId: string,
  tokens: ExchangedTokens,
  log: Logger,
): Promise<CompletedConnection> {
  // Granular consent lets a user untick scopes on Google's screen.
  const missing = missingScopes(tokens.scopes);
  if (missing.length > 0) {
    throw new AppError('YOUTUBE_INSUFFICIENT_SCOPE', {
      detail: `missing scopes: ${missing.join(' ')}`,
      params: { missing: missing.length },
    });
  }

  if (!tokens.refreshToken) {
    // prompt=consent + access_type=offline should always yield one.
    throw new AppError('OAUTH_FAILED', { detail: 'token response carried no refresh_token' });
  }

  await reserveYouTubeQuota('channels.list', 'interactive');
  const channels = await getYouTubeService().listOwnedChannels(tokens.accessToken, log);

  if (channels.length === 0) {
    throw new AppError('YOUTUBE_NO_CHANNEL', { detail: 'account has no YouTube channel' });
  }

  for (const channel of channels) {
    const owner = await channelRepository.ownerOf(channel.youtubeChannelId);
    if (owner && owner !== userId) {
      // One owner per channel in v1 (docs/architecture/03 §3.4). Say so plainly
      // rather than silently creating a second copy.
      throw conflict('errors.channels.ownedByAnotherUser');
    }
  }

  const vault = getTokenVault();
  const refreshToken = tokens.refreshToken;

  const result = await prisma.$transaction(async (tx) => {
    // Re-check the plan limit inside the transaction: several consent tabs may
    // finish at once.
    const { maxChannels } = await userRepository.planLimits(userId, tx);
    const alreadyMine = new Set<string>();
    for (const channel of channels) {
      if ((await channelRepository.ownerOf(channel.youtubeChannelId, tx)) === userId) {
        alreadyMine.add(channel.youtubeChannelId);
      }
    }
    const activeNow = await tx.youTubeChannel.count({ where: { userId, disconnectedAt: null } });
    const adding = channels.filter((c) => !alreadyMine.has(c.youtubeChannelId)).length;
    if (activeNow + adding > maxChannels) {
      throw conflict('errors.channels.limitReached', { limit: maxChannels });
    }

    const existing = await connectionRepository.findByGoogleSub(userId, tokens.identity.sub, tx);
    const connectionId = existing?.id ?? randomUUID();
    // AAD = the row id: this ciphertext opens only on this row.
    const ciphertext = vault.encrypt(refreshToken, connectionId);

    const connection = await connectionRepository.save(
      {
        id: connectionId,
        userId,
        googleSub: tokens.identity.sub,
        googleEmail: tokens.identity.email,
        encryptedRefreshToken: ciphertext,
        encryptionKeyVersion: Buffer.from(ciphertext, 'base64')[0] as number,
        scopes: tokens.scopes,
      },
      tx,
    );

    const attached = [];
    for (const summary of channels) {
      const { channel, reattached } = await channelRepository.attach(
        userId,
        connection.id,
        {
          youtubeChannelId: summary.youtubeChannelId,
          title: summary.title,
          handle: summary.handle,
          description: summary.description,
          thumbnailUrl: summary.thumbnailUrl,
          country: summary.country,
          uploadsPlaylistId: summary.uploadsPlaylistId,
          publishedAt: summary.publishedAt,
        },
        tx,
      );

      // channels.list already returned the counters; keep them rather than
      // spending another unit to fetch them again.
      await tx.channelStatsSnapshot.create({
        data: {
          channelId: channel.id,
          subscriberCount: summary.subscriberCount,
          viewCount: summary.viewCount,
          videoCount: summary.videoCount,
        },
      });

      attached.push({ id: channel.id, title: channel.title, reattached });
    }

    await auditRepository.record(
      {
        userId,
        action: existing ? 'youtube.connection.reconnected' : 'youtube.connection.created',
        resourceType: 'YouTubeConnection',
        resourceId: connection.id,
        metadata: { channels: attached.map((c) => c.id), scopes: tokens.scopes },
      },
      tx,
    );

    return { connectionId: connection.id, channels: attached };
  });

  // The access token from the exchange is good for about an hour; the first
  // sync can use it instead of refreshing immediately.
  primeAccessToken(result.connectionId, tokens.accessToken, tokens.expiresInSeconds);

  // First full video sync. Never fails the connect: on a queue outage the
  // scheduler picks the channel up on its next tick.
  await enqueueInitialSync(
    userId,
    result.channels.map((channel) => channel.id),
    log,
  );

  log.info(
    { connectionId: result.connectionId, channelCount: result.channels.length },
    'youtube channel connected',
  );

  return result;
}

async function revokeQuietly(tokens: ExchangedTokens, log: Logger): Promise<void> {
  try {
    await revokeToken(tokens.refreshToken ?? tokens.accessToken, log);
  } catch (error) {
    // Best effort. The grant simply ages out if Google is unreachable; the user
    // sees the original error, not this one.
    log.warn({ err: { errorCode: toAppError(error).code } }, 'could not revoke abandoned grant');
  }
}
