import { z } from 'zod';

import { SUPPORTED_LOCALES } from '@/domain/ai/types';
import { ASSET_KINDS } from '@/domain/content/assets';
import { PROJECT_STATUSES } from '@/domain/content/status';

/**
 * Request contracts for content management — shared by the API routes and the
 * page forms so both validate identically. Dates arrive as the browser's
 * zone-less local strings; the use cases convert them with the user's saved
 * time zone (src/domain/content/time.ts).
 */

const id = z.string().min(1).max(64);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
const title = z.string().trim().min(1).max(150);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateIdeaRequest = z
  .object({
    title,
    angle: optionalText(400),
    hook: optionalText(200),
    format: optionalText(40),
    keywords: z
      .union([z.array(z.string().trim().min(1).max(40)).max(10), z.string().max(450)])
      .optional()
      .transform((value) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean)
              .slice(0, 10)
          : (value ?? []),
      ),
    channelId: id.optional(),
  })
  .strict();

export const UpdateIdeaRequest = z.object({ status: z.enum(['SAVED', 'ARCHIVED']) }).strict();

export const CreateProjectRequest = z
  .object({
    title,
    notes: optionalText(5_000),
    channelId: id.optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .strict();

/** From an idea instead of from scratch. */
export const PromoteIdeaRequest = z.object({ ideaId: id }).strict();

export const UpdateProjectRequest = z
  .object({
    title: title.optional(),
    notes: z.string().trim().max(5_000).optional(),
    channelId: id.nullable().optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    /** Local wall-clock time, or null / "" to clear. */
    scheduledFor: z.union([localDateTime, z.literal(''), z.null()]).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    statusNote: optionalText(300),
  })
  .strict();

export const AddAssetRequest = z.union([
  z
    .object({
      kind: z.enum(ASSET_KINDS),
      body: z.string().trim().min(1).max(60_000),
      locale: z.enum(SUPPORTED_LOCALES).optional(),
    })
    .strict(),
  z
    .object({
      generationId: id,
      pick: z.coerce.number().int().min(0).max(9).default(0),
    })
    .strict(),
]);

export const CalendarQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).strict();

export const CreateCalendarEntryRequest = z
  .object({
    title,
    entryType: z.enum(['REMINDER', 'TASK', 'NOTE']).default('TASK'),
    /** A date for all-day entries, a date and time otherwise. */
    startsAt: z.union([localDateTime, localDate]),
    notes: optionalText(2_000),
    projectId: id.optional(),
  })
  .strict();

export const UpdateCalendarEntryRequest = z
  .object({
    title: title.optional(),
    status: z.enum(['PENDING', 'DONE', 'CANCELLED']).optional(),
    startsAt: z.union([localDateTime, localDate]).optional(),
    notes: z.string().trim().max(2_000).optional(),
  })
  .strict();

export type CreateIdeaRequest = z.infer<typeof CreateIdeaRequest>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
export type AddAssetRequest = z.infer<typeof AddAssetRequest>;
export type CreateCalendarEntryRequest = z.infer<typeof CreateCalendarEntryRequest>;
export type UpdateCalendarEntryRequest = z.infer<typeof UpdateCalendarEntryRequest>;
