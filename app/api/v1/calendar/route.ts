import { withApi } from '@/lib/api/with-api';
import { parseMonth } from '@/domain/content/time';
import { AppError } from '@/domain/errors/app-error';
import { err } from '@/domain/errors/result';
import { createCalendarEntry, getCalendarMonth } from '@/modules/content/calendar';
import { CalendarQuery, CreateCalendarEntryRequest } from '@/modules/content/inputs';

export const dynamic = 'force-dynamic';

/** One month (`?month=2026-10`) of scheduled projects and entries, in the user's time zone. */
export const GET = withApi({ auth: 'required', query: CalendarQuery }, async ({ user, query }) => {
  const month = parseMonth(query.month);
  if (!month) return err(new AppError('VALIDATION_FAILED', { detail: 'month out of range' }));
  return getCalendarMonth(user.id, month.year, month.month);
});

export const POST = withApi(
  {
    auth: 'required',
    body: CreateCalendarEntryRequest,
    successStatus: 201,
    rateLimit: { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' },
    audit: 'content.calendar.created',
  },
  async ({ user, body }) => createCalendarEntry(user.id, body),
);
