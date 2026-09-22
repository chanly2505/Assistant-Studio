import type { Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { channelRepository } from '@/db/repositories/channel.repository';
import { isValidTimeZone } from '@/domain/content/time';
import { AppError, notFound } from '@/domain/errors/app-error';

/** The user's saved IANA time zone; UTC when unset or no longer valid. */
export async function userTimeZone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const zone = user?.timezone ?? 'UTC';
  return isValidTimeZone(zone) ? zone : 'UTC';
}

/** Throws NOT_FOUND unless the channel exists and belongs to the user. */
export async function assertOwnChannel(userId: string, channelId: string | null | undefined) {
  if (!channelId) return;
  const channel = await channelRepository.findForUser(userId, channelId);
  if (!channel) throw notFound('channel');
}

/**
 * Loads a live (not soft-deleted) project owned by the user and takes a row
 * lock on it for the rest of the transaction.
 *
 * Every change to a project's assets or status goes through this lock, which
 * serialises them per project: two tabs adding a version at once get versions
 * n and n+1, never a duplicate; two "select this one" clicks leave exactly one
 * selected. The lock is per project, so it never contends across users.
 */
export async function lockProject(tx: Prisma.TransactionClient, userId: string, projectId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ContentProject"
    WHERE id = ${projectId} AND "userId" = ${userId} AND "deletedAt" IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) throw notFound('project');
  return tx.contentProject.findUniqueOrThrow({ where: { id: projectId } });
}

export function validation(messageKey: string, detail: string) {
  return new AppError('VALIDATION_FAILED', { messageKey, detail });
}
