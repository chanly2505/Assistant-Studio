import { Prisma } from '@prisma/client';
import type { Logger } from 'pino';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { AppError, notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import { logger as rootLogger } from '@/lib/logger';
import { getTokenVault } from '@/services/crypto';
import { revokeToken } from '@/services/google/oauth';
import type { RevocationOutcome } from '@/modules/channels/disconnect-channel';
import { evictAccessToken } from '@/modules/youtube/access-token';

/**
 * The user's right to their data. docs/architecture/08 §8.7
 *
 *   export  everything tied to the account, as one JSON document
 *   delete  revoke every Google grant → remove YouTube and content data →
 *           keep only what must stay, with nothing pointing back at the user
 *
 * What survives deletion, and why: AI generation rows keep their token count
 * and cost (the platform-wide spend breaker counts them) but lose the user
 * link and every word of input and output; audit rows lose the user link
 * (onDelete: SetNull). Nothing that identifies the person remains.
 */

export const EXPORT_FORMAT_VERSION = 1;

/** BigInt counters as strings: JSON has no 64-bit integers. */
function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

export async function exportAccount(userId: string, now = new Date()) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      email: true,
      name: true,
      locale: true,
      timezone: true,
      planKey: true,
      createdAt: true,
      settings: { select: { contentLanguage: true, defaultChannelId: true, updatedAt: true } },
    },
  });
  if (!user) return err(notFound('user'));

  const [connections, channels, ideas, projects, calendar, generations, usage, activity] =
    await Promise.all([
      // Never the encrypted refresh token: an export is a file the user may share.
      prisma.youTubeConnection.findMany({
        where: { userId },
        select: { googleEmail: true, status: true, scopes: true, grantedAt: true, revokedAt: true },
      }),
      prisma.youTubeChannel.findMany({
        where: { userId },
        select: {
          id: true,
          youtubeChannelId: true,
          title: true,
          handle: true,
          connectedAt: true,
          disconnectedAt: true,
          settings: {
            select: { niche: true, targetAudience: true, brandVoice: true, keywords: true },
          },
          statsSnapshots: {
            select: { capturedAt: true, subscriberCount: true, viewCount: true, videoCount: true },
            orderBy: { capturedAt: 'asc' },
          },
          videos: {
            select: {
              youtubeVideoId: true,
              title: true,
              publishedAt: true,
              durationSeconds: true,
              privacyStatus: true,
            },
            orderBy: { publishedAt: 'desc' },
          },
          analytics: { orderBy: { date: 'asc' } },
        },
      }),
      prisma.contentIdea.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.contentProject.findMany({
        where: { userId },
        include: { assets: true, statusEvents: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.calendarEntry.findMany({ where: { userId }, orderBy: { startsAt: 'asc' } }),
      prisma.aIGeneration.findMany({
        where: { userId },
        select: {
          id: true,
          feature: true,
          model: true,
          locale: true,
          status: true,
          inputJson: true,
          outputJson: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.usageCounter.findMany({ where: { userId } }),
      prisma.auditLog.findMany({
        where: { userId },
        select: { action: true, resourceType: true, resourceId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

  return ok(
    jsonSafe({
      format: 'youtube-studio-assistant-export',
      version: EXPORT_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      account: user,
      youtubeConnections: connections,
      channels,
      ideas,
      projects,
      calendar,
      aiGenerations: generations,
      aiUsage: usage,
      activity,
    }) as Record<string, unknown>,
  );
}

export interface DeletionReport {
  connections: number;
  revocations: Record<RevocationOutcome, number>;
}

/**
 * Deletes the account now. `confirmEmail` must match the account's address —
 * a typed confirmation, so a stray click or a forged request cannot do it.
 * Google revocation is best effort per grant (Google may be unreachable); the
 * local copy of every grant is destroyed regardless.
 */
export async function deleteAccount(
  userId: string,
  confirmEmail: string,
  log: Logger = rootLogger,
): Promise<Result<DeletionReport>> {
  try {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true },
    });
    if (!user) throw notFound('user');
    if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', {
        messageKey: 'errors.account.confirmMismatch',
        detail: 'confirmation email does not match',
      });
    }

    const connections = await prisma.youTubeConnection.findMany({ where: { userId } });
    const revocations: Record<RevocationOutcome, number> = {
      revoked: 0,
      already_invalid: 0,
      failed: 0,
      not_needed: 0,
    };
    for (const connection of connections) {
      evictAccessToken(connection.id);
      if (connection.status === 'REVOKED' || !connection.encryptedRefreshToken) {
        revocations.not_needed += 1;
        continue;
      }
      try {
        const token = getTokenVault().decrypt(
          connection.encryptedRefreshToken,
          connection.id,
          'refreshToken',
        );
        revocations[await revokeToken(token, log)] += 1;
      } catch (error) {
        revocations.failed += 1;
        log.warn(
          { err: { errorCode: toAppError(error).code }, connectionId: connection.id },
          'revocation failed during account deletion; deleting the grant anyway',
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      // Keep the cost (the spend breaker counts it); drop every word.
      await tx.aIGeneration.updateMany({
        where: { userId },
        data: { inputJson: Prisma.DbNull, outputJson: Prisma.DbNull },
      });
      await auditRepository.record(
        {
          userId,
          action: 'account.deleted',
          resourceType: 'User',
          metadata: { connections: connections.length, revocations: { ...revocations } },
        },
        tx,
      );
      // Cascades: sessions, settings, grants, channels (videos, statistics,
      // analytics), ideas, projects (versions, history), calendar, usage.
      // SetNull: audit rows and AI generations keep no link to the person.
      await tx.user.delete({ where: { id: userId } });
    });

    log.info({ connections: connections.length, revocations }, 'account deleted');
    return ok({ connections: connections.length, revocations });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}
