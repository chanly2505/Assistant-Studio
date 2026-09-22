import { z } from 'zod';

import { SUPPORTED_LOCALES } from '@/domain/ai/types';

/**
 * Request contracts for the five AI features — shared by the API routes and
 * the Studio forms, so both validate identically. Every text field is length-
 * capped: it bounds prompt cost and the room available for injection attempts.
 */

const text = (max: number) => z.string().trim().min(3).max(max);
const locale = z.enum(SUPPORTED_LOCALES).default('en');
const channelId = z.string().min(1).max(64).optional();

export const IdeasRequest = z
  .object({
    topic: text(300),
    count: z.coerce.number().int().min(3).max(10).default(6),
    locale,
    channelId,
  })
  .strict();

export const TitlesRequest = z
  .object({
    topic: text(500),
    existingTitle: z.string().trim().max(100).optional(),
    locale,
    channelId,
  })
  .strict();

export const DescriptionRequest = z
  .object({
    title: text(100),
    summary: text(2000),
    includeChapters: z.coerce.boolean().default(false),
    locale,
    channelId,
  })
  .strict();

export const ScriptRequest = z
  .object({
    title: text(100),
    outline: z.string().trim().max(3000).optional(),
    targetMinutes: z.coerce.number().int().min(1).max(30).default(8),
    locale,
    channelId,
  })
  .strict();

export const PlanRequest = z
  .object({
    goal: text(500),
    weeks: z.coerce.number().int().min(1).max(12).default(4),
    locale,
    channelId,
  })
  .strict();

export type IdeasRequest = z.infer<typeof IdeasRequest>;
export type TitlesRequest = z.infer<typeof TitlesRequest>;
export type DescriptionRequest = z.infer<typeof DescriptionRequest>;
export type ScriptRequest = z.infer<typeof ScriptRequest>;
export type PlanRequest = z.infer<typeof PlanRequest>;
