import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import {
  isValidTimeZone,
  localDateKey,
  monthRange,
  parseLocalDate,
  parseLocalDateTime,
} from '@/domain/content/time';
import { notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

import type { CreateCalendarEntryRequest, UpdateCalendarEntryRequest } from './inputs';
import { userTimeZone, validation } from './shared';

/**
 * The calendar is a VIEW over dated things (docs/architecture/03 §5): projects
 * appear through `scheduledFor`; a CalendarEntry exists only for items with no
 * project behind them (reminders, "film B-roll"). No join table to drift.
 */

export type CalendarItem =
  | {
      type: 'project';
      id: string;
      title: string;
      at: Date;
      dayKey: string;
      status: string;
    }
  | {
      type: 'entry';
      id: string;
      title: string;
      at: Date;
      dayKey: string;
      allDay: boolean;
      entryType: string;
      status: string;
      projectId: string | null;
    };

export async function getCalendarMonth(userId: string, year: number, month: number) {
  const zone = await userTimeZone(userId);
  const { start, end } = monthRange(year, month, zone);

  const [projects, entries] = await Promise.all([
    prisma.contentProject.findMany({
      where: {
        userId,
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        scheduledFor: { gte: start, lt: end },
      },
      select: { id: true, title: true, scheduledFor: true, status: true },
      orderBy: { scheduledFor: 'asc' },
      take: 500,
    }),
    prisma.calendarEntry.findMany({
      where: {
        userId,
        startsAt: { gte: start, lt: end },
        OR: [{ projectId: null }, { project: { deletedAt: null } }],
      },
      orderBy: { startsAt: 'asc' },
      take: 500,
    }),
  ]);

  const items: CalendarItem[] = [
    ...projects.map((p) => ({
      type: 'project' as const,
      id: p.id,
      title: p.title,
      at: p.scheduledFor as Date,
      dayKey: localDateKey(p.scheduledFor as Date, zone),
      status: p.status,
    })),
    ...entries.map((e) => ({
      type: 'entry' as const,
      id: e.id,
      title: e.title,
      at: e.startsAt,
      dayKey: localDateKey(e.startsAt, zone),
      allDay: e.allDay,
      entryType: e.entryType,
      status: e.status,
      projectId: e.projectId,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return ok({ zone, start, end, items });
}

/** A date-only value is an all-day entry, starting at local midnight. */
function parseStart(value: string, zone: string) {
  const allDay = !value.includes('T');
  const startsAt = allDay ? parseLocalDate(value, zone) : parseLocalDateTime(value, zone);
  if (!startsAt) throw validation('errors.validationFailed', 'unparseable startsAt');
  return { startsAt, allDay };
}

export async function createCalendarEntry(
  userId: string,
  input: CreateCalendarEntryRequest,
): Promise<Result<{ entryId: string }>> {
  try {
    const zone = await userTimeZone(userId);
    const { startsAt, allDay } = parseStart(input.startsAt, zone);
    if (input.projectId) {
      const project = await prisma.contentProject.findFirst({
        where: { id: input.projectId, userId, deletedAt: null },
        select: { channelId: true },
      });
      if (!project) throw notFound('project');
    }
    const entry = await prisma.calendarEntry.create({
      data: {
        userId,
        title: input.title,
        entryType: input.entryType,
        startsAt,
        allDay,
        notes: input.notes ?? null,
        projectId: input.projectId ?? null,
      },
      select: { id: true },
    });
    await auditRepository.record({
      userId,
      action: 'content.calendar.created',
      resourceType: 'CalendarEntry',
      resourceId: entry.id,
    });
    return ok({ entryId: entry.id });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

export async function updateCalendarEntry(
  userId: string,
  entryId: string,
  input: UpdateCalendarEntryRequest,
): Promise<Result<{ entryId: string }>> {
  try {
    const timing = input.startsAt ? parseStart(input.startsAt, await userTimeZone(userId)) : {};
    const updated = await prisma.calendarEntry.updateMany({
      where: { id: entryId, userId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
        ...timing,
      },
    });
    if (updated.count === 0) throw notFound('calendar entry');
    return ok({ entryId });
  } catch (thrown) {
    return err(toAppError(thrown));
  }
}

export async function deleteCalendarEntry(
  userId: string,
  entryId: string,
): Promise<Result<{ entryId: string }>> {
  const deleted = await prisma.calendarEntry.deleteMany({ where: { id: entryId, userId } });
  if (deleted.count === 0) return err(notFound('calendar entry'));
  await auditRepository.record({
    userId,
    action: 'content.calendar.deleted',
    resourceType: 'CalendarEntry',
    resourceId: entryId,
  });
  return ok({ entryId });
}

/** Saves the zone dates are shown and entered in (detected by the browser). */
export async function setTimeZone(userId: string, zone: string): Promise<Result<{ zone: string }>> {
  if (!isValidTimeZone(zone))
    return err(validation('errors.content.badTimeZone', 'invalid IANA zone'));
  await prisma.user.update({ where: { id: userId }, data: { timezone: zone } });
  return ok({ zone });
}
