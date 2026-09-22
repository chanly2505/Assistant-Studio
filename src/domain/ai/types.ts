import { z } from 'zod';

/**
 * Structured AI output contracts.
 *
 * These schemas are the boundary the rest of the system trusts. The provider is
 * also given a JSON schema derived from them, but provider-side enforcement is a
 * strong constraint, not a guarantee — so every response is parsed here too.
 *
 * docs/architecture/07-ai-architecture.md §7.3
 */

export const AI_FEATURES = ['IDEAS', 'TITLES', 'DESCRIPTION', 'SCRIPT', 'PLAN'] as const;
export type AIFeatureName = (typeof AI_FEATURES)[number];

export const SUPPORTED_LOCALES = ['en', 'km', 'th', 'vi', 'zh'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/* ------------------------------- outputs -------------------------------- */

export const ContentIdeasOutput = z
  .object({
    ideas: z
      .array(
        z.object({
          title: z.string().min(5).max(120),
          angle: z.string().min(10).max(400),
          hook: z.string().min(5).max(200),
          format: z.enum(['short', 'long', 'tutorial', 'vlog', 'interview', 'review']),
          keywords: z.array(z.string().min(1).max(40)).min(1).max(10),
          rationale: z.string().max(400),
        }),
      )
      .min(3)
      .max(10),
  })
  .strict();

export const TitlesOutput = z
  .object({
    titles: z
      .array(
        z.object({
          text: z.string().min(10).max(100),
          style: z.enum(['curiosity', 'howto', 'listicle', 'emotional', 'direct']),
          reasoning: z.string().max(280),
          /** A model opinion, labelled as such in the UI. Never presented as measured data. */
          estimatedStrength: z.number().int().min(1).max(5),
        }),
      )
      .min(5)
      .max(10),
  })
  .strict();

export const DescriptionOutput = z
  .object({
    description: z.string().min(50).max(5000),
    /**
     * Letters, combining marks, digits and underscore in any script. `\p{M}` is
     * required: Khmer and Thai write vowels as combining marks, so a letters-only
     * class would reject real hashtags. Whitespace of every kind (NBSP, zero-width,
     * ideographic) is excluded because YouTube splits a hashtag on it.
     */
    hashtags: z.array(z.string().regex(/^#[\p{L}\p{M}\p{N}_]+$/u)).max(15),
    chapters: z
      .array(
        z.object({
          timestamp: z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/),
          label: z.string().max(100),
        }),
      )
      .max(30)
      // Nullish, not just optional: OpenAI strict mode requires every field, so
      // "no chapters" arrives as null.
      .nullish(),
  })
  .strict();

export const ScriptOutput = z
  .object({
    hook: z.string().min(10).max(1000),
    sections: z
      .array(z.object({ heading: z.string().max(120), body: z.string().min(20).max(6000) }))
      .min(1)
      .max(20),
    callToAction: z.string().max(600),
    estimatedDurationSeconds: z.number().int().min(15).max(7200),
  })
  .strict();

export const ContentPlanOutput = z
  .object({
    summary: z.string().max(1200),
    cadence: z.string().max(200),
    entries: z
      .array(
        z.object({
          week: z.number().int().min(1).max(52),
          title: z.string().min(5).max(120),
          format: z.string().max(40),
          goal: z.string().max(300),
        }),
      )
      .min(1)
      .max(52),
  })
  .strict();

export type ContentIdeasOutput = z.infer<typeof ContentIdeasOutput>;
export type TitlesOutput = z.infer<typeof TitlesOutput>;
export type DescriptionOutput = z.infer<typeof DescriptionOutput>;
export type ScriptOutput = z.infer<typeof ScriptOutput>;
export type ContentPlanOutput = z.infer<typeof ContentPlanOutput>;

export const OUTPUT_SCHEMA_BY_FEATURE = {
  IDEAS: ContentIdeasOutput,
  TITLES: TitlesOutput,
  DESCRIPTION: DescriptionOutput,
  SCRIPT: ScriptOutput,
  PLAN: ContentPlanOutput,
} as const;

/* -------------------------------- usage --------------------------------- */

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface AIResult<T> {
  data: T;
  /** AIGeneration row id — the provenance link stored alongside saved content. */
  generationId: string;
  usage: AIUsage;
  model: string;
  promptVersion: string;
  cached: boolean;
}
