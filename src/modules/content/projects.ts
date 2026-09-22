import type { Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/domain/ai/types';
import { checkTransition, transitionEffects, type ProjectStatus } from '@/domain/content/status';
import { parseLocalDateTime } from '@/domain/content/time';
import { conflict, notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

import type { CreateProjectRequest, UpdateProjectRequest } from './inputs';
import { assertOwnChannel, lockProject, userTimeZone, validation } from './shared';

/** Keeps one account from growing without bound; far above real use. */
export const MAX_ACTIVE_PROJECTS = 500;

const live = (userId: string) => ({ userId, deletedAt: null });

async function assertRoomForProject(tx: Prisma.TransactionClient, userId: string) {
  const count = await tx.contentProject.count({
    where: { ...live(userId), status: { not: 'ARCHIVED' } },
  });
  if (count >= MAX_ACTIVE_PROJECTS) {
    throw conflict('errors.content.tooManyProjects', { limit: MAX_ACTIVE_PROJECTS });
  }
}

async function defaultLocale(userId: string): Promise<SupportedLocale> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { contentLanguage: true },
  });
  const language = settings?.contentLanguage ?? 'en';
  return (SUPPORTED_LOCALES as readonly string[]).includes(language)
    ? (language as SupportedLocale)
    : 'en';
}

/** A project started from scratch. */
export async function createProject(
  userId: string,
  input: CreateProjectRequest,
): Promise<Result<{ projectId: string }>> {
  try {
    await assertOwnChannel(userId, input.channelId);
    const locale = input.locale ?? (await defaultLocale(userId));
    const project = await prisma.$transaction(async (tx) => {
      await assertRoomForProject(tx, userId);
      const created = await tx.contentProject.create({
        data: {
          userId,
          channelId: input.channelId ?? null,
          title: input.title,
          notes: input.notes ?? null,
          locale,
          statusEvents: { create: { toStatus: 'IDEA', changedByUserId: userId } },
        },
        select: { id: true },
      });
      await auditRepository.record(
        {
          userId,
          action: 'content.project.created',
          resourceType: 'ContentProject',
          resourceId: created.id,
        },
        tx,
      );
      return created;
    });
    return ok({ projectId: project.id });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

/**
 * An idea becomes a project. Idempotent: promoting the same idea twice (a
 * double click, a retried request) returns the project it already became.
 *
 * The idea's title seeds the project's first TITLE version, keeping the AI
 * provenance; angle and hook become the project's opening notes.
 */
export async function promoteIdea(
  userId: string,
  ideaId: string,
): Promise<Result<{ projectId: string; created: boolean }>> {
  try {
    const fallbackLocale = await defaultLocale(userId);
    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "ContentIdea" WHERE id = ${ideaId} AND "userId" = ${userId} FOR UPDATE
      `;
      if (locked.length === 0) throw notFound('idea');
      const idea = await tx.contentIdea.findUniqueOrThrow({
        where: { id: ideaId },
        include: {
          project: { select: { id: true, deletedAt: true } },
          aiGeneration: { select: { locale: true } },
        },
      });

      if (idea.status === 'PROMOTED' && idea.project && !idea.project.deletedAt) {
        return { projectId: idea.project.id, created: false };
      }

      await assertRoomForProject(tx, userId);
      const generationLocale = idea.aiGeneration?.locale;
      const locale =
        generationLocale && (SUPPORTED_LOCALES as readonly string[]).includes(generationLocale)
          ? generationLocale
          : fallbackLocale;
      const notes = [idea.angle, idea.hook, idea.rationale].filter(Boolean).join('\n\n') || null;

      const project = await tx.contentProject.create({
        data: {
          userId,
          channelId: idea.channelId,
          title: idea.title.slice(0, 150),
          notes,
          locale,
          statusEvents: { create: { toStatus: 'IDEA', changedByUserId: userId } },
          assets: {
            create: {
              kind: 'TITLE',
              locale,
              body: idea.title.slice(0, 100),
              version: 1,
              isSelected: true,
              createdBy: idea.source,
              aiGenerationId: idea.aiGenerationId,
            },
          },
        },
        select: { id: true },
      });
      await tx.contentIdea.update({
        where: { id: ideaId },
        data: { status: 'PROMOTED', projectId: project.id, archivedAt: null },
      });
      await auditRepository.record(
        {
          userId,
          action: 'content.idea.promoted',
          resourceType: 'ContentProject',
          resourceId: project.id,
          metadata: { ideaId },
        },
        tx,
      );
      return { projectId: project.id, created: true };
    });
    return ok(outcome);
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

/** The board: every live, unarchived project, most recently touched first. */
export async function listProjects(userId: string, options: { archived?: boolean } = {}) {
  const projects = await prisma.contentProject.findMany({
    where: {
      ...live(userId),
      status: options.archived ? 'ARCHIVED' : { not: 'ARCHIVED' },
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_ACTIVE_PROJECTS,
    select: {
      id: true,
      title: true,
      status: true,
      scheduledFor: true,
      publishedAt: true,
      locale: true,
      updatedAt: true,
      channel: { select: { title: true } },
      _count: { select: { assets: true } },
    },
  });
  const archivedCount = options.archived
    ? projects.length
    : await prisma.contentProject.count({ where: { ...live(userId), status: 'ARCHIVED' } });
  return ok({ projects, archivedCount });
}

export async function getProject(userId: string, projectId: string) {
  const project = await prisma.contentProject.findFirst({
    where: { id: projectId, ...live(userId) },
    include: {
      channel: { select: { id: true, title: true } },
      assets: { orderBy: [{ kind: 'asc' }, { locale: 'asc' }, { version: 'desc' }] },
      statusEvents: { orderBy: { createdAt: 'desc' }, take: 50 },
      ideas: { select: { id: true, title: true, source: true } },
      calendar: { orderBy: { startsAt: 'asc' }, take: 50 },
    },
  });
  return project ? ok(project) : err(notFound('project'));
}

/**
 * Edits details and/or moves the status, in one transaction under the
 * project lock. The schedule is applied first so "set a date and schedule it"
 * works as a single request.
 */
export async function updateProject(
  userId: string,
  projectId: string,
  input: UpdateProjectRequest,
  now = new Date(),
): Promise<Result<{ projectId: string; status: ProjectStatus }>> {
  try {
    await assertOwnChannel(userId, input.channelId);
    const zone = await userTimeZone(userId);

    let scheduledFor: Date | null | undefined;
    if (input.scheduledFor === null || input.scheduledFor === '') scheduledFor = null;
    else if (input.scheduledFor !== undefined) {
      scheduledFor = parseLocalDateTime(input.scheduledFor, zone);
      if (!scheduledFor) throw validation('errors.validationFailed', 'unparseable scheduledFor');
    }

    const status = await prisma.$transaction(async (tx) => {
      const project = await lockProject(tx, userId, projectId);
      const from = project.status as ProjectStatus;
      const to = (input.status ?? from) as ProjectStatus;
      const effectiveSchedule = scheduledFor === undefined ? project.scheduledFor : scheduledFor;

      if (to !== from) {
        const problem = checkTransition(from, to, { scheduledFor: effectiveSchedule });
        if (problem === 'NEEDS_SCHEDULE_DATE') {
          throw validation('errors.content.needsScheduleDate', 'SCHEDULED without a date');
        }
      } else if (from === 'SCHEDULED' && effectiveSchedule === null) {
        throw validation(
          'errors.content.needsScheduleDate',
          'cleared the date of a SCHEDULED project',
        );
      }

      await tx.contentProject.update({
        where: { id: projectId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
          ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(scheduledFor !== undefined ? { scheduledFor } : {}),
          ...(to !== from ? { status: to, ...transitionEffects(from, to, now) } : {}),
        },
      });

      if (to !== from) {
        await tx.contentStatusEvent.create({
          data: {
            projectId,
            fromStatus: from,
            toStatus: to,
            changedByUserId: userId,
            note: input.statusNote ?? null,
          },
        });
        await auditRepository.record(
          {
            userId,
            action: 'content.project.status_changed',
            resourceType: 'ContentProject',
            resourceId: projectId,
            metadata: { from, to },
          },
          tx,
        );
      }
      return to;
    });
    return ok({ projectId, status });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

/** Soft delete: hidden everywhere, kept for the audit trail. */
export async function deleteProject(
  userId: string,
  projectId: string,
): Promise<Result<{ projectId: string }>> {
  const deleted = await prisma.contentProject.updateMany({
    where: { id: projectId, ...live(userId) },
    data: { deletedAt: new Date() },
  });
  if (deleted.count === 0) return err(notFound('project'));
  // Its ideas return to the idea list rather than pointing at a hidden project.
  await prisma.contentIdea.updateMany({
    where: { projectId, userId },
    data: { status: 'SAVED', projectId: null },
  });
  await auditRepository.record({
    userId,
    action: 'content.project.deleted',
    resourceType: 'ContentProject',
    resourceId: projectId,
  });
  return ok({ projectId });
}

/** The status a project had before it was archived — what "Restore" returns it to. */
export function statusBeforeArchive(
  events: Array<{ fromStatus: string | null; toStatus: string }>,
): ProjectStatus {
  const archived = events.find((event) => event.toStatus === 'ARCHIVED');
  const previous = archived?.fromStatus;
  return previous && previous !== 'ARCHIVED' ? (previous as ProjectStatus) : 'IDEA';
}
