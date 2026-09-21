import type { Logger } from 'pino';

import { auditRepository } from '@/db/repositories/audit.repository';
import { connectionRepository } from '@/db/repositories/connection.repository';
import { AppError, notFound } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';
import { logger as rootLogger } from '@/lib/logger';
import { getTokenVault } from '@/services/crypto';
import { refreshAccessToken } from '@/services/google/oauth';

/**
 * Turns a YouTube connection into a usable access token.
 * docs/architecture/05-authentication-architecture.md §5.4
 *
 * - Access tokens are never persisted. They live in this process's memory until
 *   two minutes before expiry.
 * - Concurrent callers for the same connection share ONE refresh request
 *   (single-flight), so a burst of sync jobs does not stampede Google.
 * - A distributed lock is NOT needed: Google does not rotate refresh tokens for
 *   this grant type, so two instances refreshing at once both get valid access
 *   tokens and nothing is invalidated. The cost is at most one extra refresh per
 *   instance. When Redis arrives (Phase 4) the cache moves there to share it.
 * - `invalid_grant` marks the connection REAUTH_REQUIRED, which is expected
 *   product state: later calls fail fast without contacting Google.
 */

const EXPIRY_SKEW_MS = 120_000;

interface CachedToken {
  token: SecretString;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<SecretString>>();

export async function getAccessToken(params: {
  userId: string;
  connectionId: string;
  log?: Logger;
}): Promise<SecretString> {
  const cached = cache.get(params.connectionId);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

  const pending = inflight.get(params.connectionId);
  if (pending) return pending;

  const refresh = refreshFor(params).finally(() => inflight.delete(params.connectionId));
  inflight.set(params.connectionId, refresh);
  return refresh;
}

async function refreshFor(params: {
  userId: string;
  connectionId: string;
  log?: Logger;
}): Promise<SecretString> {
  const log = params.log ?? rootLogger;
  const connection = await connectionRepository.findForUser(params.userId, params.connectionId);

  if (!connection) throw notFound('youtube connection');
  if (connection.status !== 'ACTIVE') {
    throw new AppError('YOUTUBE_REAUTH_REQUIRED', {
      detail: `connection is ${connection.status}`,
    });
  }

  const vault = getTokenVault();
  const refreshToken = vault.decrypt(
    connection.encryptedRefreshToken,
    connection.id,
    'refreshToken',
  );

  let refreshed;
  try {
    refreshed = await refreshAccessToken(refreshToken, log);
  } catch (error) {
    if (AppError.is(error) && error.code === 'YOUTUBE_REAUTH_REQUIRED') {
      cache.delete(connection.id);
      await connectionRepository.markReauthRequired(params.userId, connection.id, 'invalid_grant');
      await auditRepository.record({
        userId: params.userId,
        actorType: 'SYSTEM',
        action: 'youtube.connection.reauth_required',
        resourceType: 'YouTubeConnection',
        resourceId: connection.id,
      });
    }
    throw error;
  }

  primeAccessToken(connection.id, refreshed.accessToken, refreshed.expiresInSeconds);
  await connectionRepository.recordRefresh(params.userId, connection.id);

  // Key rotation: a row sealed under an old key is rewritten under the current
  // one the first time it is used. No bulk re-encryption job is required.
  if (vault.needsReEncryption(connection.encryptedRefreshToken)) {
    const current = vault.encrypt(refreshToken, connection.id);
    await connectionRepository.rotateCiphertext(
      params.userId,
      connection.id,
      current,
      Buffer.from(current, 'base64')[0] as number,
    );
  }

  return refreshed.accessToken;
}

/** Stores a token obtained elsewhere (the connect flow already holds one). */
export function primeAccessToken(
  connectionId: string,
  token: SecretString,
  expiresInSeconds: number,
): void {
  cache.set(connectionId, { token, expiresAt: Date.now() + expiresInSeconds * 1000 });
}

export function evictAccessToken(connectionId: string): void {
  cache.delete(connectionId);
}

/** Test hook. */
export function clearAccessTokenCache(): void {
  cache.clear();
  inflight.clear();
}
