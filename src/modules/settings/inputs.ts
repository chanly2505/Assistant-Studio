import { z } from 'zod';

import { SUPPORTED_LOCALES } from '@/domain/ai/types';
import { ALL_LOCALES } from '@/lib/i18n/routing';

/**
 * Settings contracts, shared by the API routes and the settings forms.
 * Availability of a display language is checked in the use case, against
 * what this deployment actually serves.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const UpdateUserSettingsRequest = z
  .object({
    /** Language of the app's own screens. */
    locale: z.enum(ALL_LOCALES).optional(),
    /** IANA zone, e.g. Asia/Phnom_Penh. */
    timezone: z.string().trim().min(1).max(64).optional(),
    /** Default language for AI-generated content and new projects. */
    contentLanguage: z.enum(SUPPORTED_LOCALES).optional(),
    /** Channel preselected in Studio; null clears it. */
    defaultChannelId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const UpdateChannelSettingsRequest = z
  .object({
    niche: optionalText(120),
    targetAudience: optionalText(1_000),
    brandVoice: optionalText(1_000),
    keywords: z
      .union([z.array(z.string().trim().min(1).max(40)).max(15), z.string().max(700)])
      .optional()
      .transform((value) =>
        value === undefined
          ? undefined
          : (typeof value === 'string' ? value.split(',') : value)
              .map((k) => k.trim())
              .filter(Boolean)
              .slice(0, 15),
      ),
  })
  .strict();

export type UpdateUserSettingsRequest = z.infer<typeof UpdateUserSettingsRequest>;
export type UpdateChannelSettingsRequest = z.infer<typeof UpdateChannelSettingsRequest>;
