import { z } from 'zod';

import { withApi } from '@/lib/api/with-api';
import { deleteCalendarEntry, updateCalendarEntry } from '@/modules/content/calendar';
import { UpdateCalendarEntryRequest } from '@/modules/content/inputs';

export const dynamic = 'force-dynamic';

const Params = z.object({ entryId: z.string().min(1).max(64) }).strict();
const limit = { key: 'content:write', points: 120, windowSec: 60, onStoreFailure: 'open' } as const;

export const PATCH = withApi(
  { auth: 'required', params: Params, body: UpdateCalendarEntryRequest, rateLimit: limit },
  async ({ user, params, body }) => updateCalendarEntry(user.id, params.entryId, body),
);

export const DELETE = withApi(
  { auth: 'required', params: Params, rateLimit: limit, audit: 'content.calendar.deleted' },
  async ({ user, params }) => deleteCalendarEntry(user.id, params.entryId),
);
