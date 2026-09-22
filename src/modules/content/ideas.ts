import type { IdeaStatus } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { conflict, notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

import type { CreateIdeaRequest } from './inputs';
import { assertOwnChannel } from './shared';

/** Newest first. PROMOTED ideas carry a link to the project they became. */
export async function listIdeas(userId: string, status: IdeaStatus = 'SAVED') {
  const ideas = await prisma.contentIdea.findMany({
    where: { userId, status },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      project: { select: { id: true, title: true, deletedAt: true } },
      channel: { select: { title: true } },
    },
  });
  const counts = await prisma.contentIdea.groupBy({
    by: ['status'],
    where: { userId },
    _count: { _all: true },
  });
  return ok({
    ideas,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<
      Record<IdeaStatus, number>
    >,
  });
}

/** An idea the creator wrote themselves. */
export async function createIdea(
  userId: string,
  input: CreateIdeaRequest,
): Promise<Result<{ ideaId: string }>> {
  try {
    await assertOwnChannel(userId, input.channelId);
    const idea = await prisma.contentIdea.create({
      data: {
        userId,
        channelId: input.channelId ?? null,
        title: input.title,
        angle: input.angle ?? null,
        hook: input.hook ?? null,
        format: input.format ?? null,
        keywords: input.keywords,
        source: 'USER',
      },
      select: { id: true },
    });
    await auditRepository.record({
      userId,
      action: 'content.idea.created',
      resourceType: 'ContentIdea',
      resourceId: idea.id,
    });
    return ok({ ideaId: idea.id });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

/** Archive or restore. A promoted idea belongs to its project and stays PROMOTED. */
export async function setIdeaStatus(
  userId: string,
  ideaId: string,
  status: 'SAVED' | 'ARCHIVED',
): Promise<Result<{ ideaId: string; status: IdeaStatus }>> {
  const updated = await prisma.contentIdea.updateMany({
    where: { id: ideaId, userId, status: { not: 'PROMOTED' } },
    data: { status, archivedAt: status === 'ARCHIVED' ? new Date() : null },
  });
  if (updated.count === 0) {
    const exists = await prisma.contentIdea.findFirst({ where: { id: ideaId, userId } });
    return err(exists ? conflict('errors.content.ideaPromoted') : notFound('idea'));
  }
  return ok({ ideaId, status });
}

/** Hard delete. Promoted ideas are kept: they are the project's provenance. */
export async function deleteIdea(
  userId: string,
  ideaId: string,
): Promise<Result<{ ideaId: string }>> {
  const deleted = await prisma.contentIdea.deleteMany({
    where: { id: ideaId, userId, status: { not: 'PROMOTED' } },
  });
  if (deleted.count === 0) {
    const exists = await prisma.contentIdea.findFirst({ where: { id: ideaId, userId } });
    return err(exists ? conflict('errors.content.ideaPromoted') : notFound('idea'));
  }
  await auditRepository.record({
    userId,
    action: 'content.idea.deleted',
    resourceType: 'ContentIdea',
    resourceId: ideaId,
  });
  return ok({ ideaId });
}
