import type { AIFeatureName } from '@/domain/ai/types';

/**
 * JSON Schemas sent to OpenAI as `text.format` (strict Structured Outputs).
 *
 * Written by hand, mirroring the Zod contracts in src/domain/ai/types.ts, so
 * they are easy to review. Strict mode requires: every property listed in
 * `required`, `additionalProperties: false` on every object, and "optional"
 * expressed as a union with null.
 *
 * These are a strong HINT to the model. The Zod schemas are the contract: every
 * response is parsed with Zod regardless. `tests/unit/services/ai-schemas`
 * checks the two agree and that every object here is strict-compatible.
 *
 * Deliberately omitted: the hashtag `pattern`. It uses Unicode property
 * escapes (\p{L}), whose support in the provider's regex dialect is not
 * documented; Zod enforces it on the way back instead.
 */

type Schema = Record<string, unknown>;

const obj = (properties: Record<string, Schema>): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const str = (min: number, max: number): Schema => ({
  type: 'string',
  minLength: min,
  maxLength: max,
});
const int = (min: number, max: number): Schema => ({ type: 'integer', minimum: min, maximum: max });
const arr = (items: Schema, min: number, max: number): Schema => ({
  type: 'array',
  items,
  minItems: min,
  maxItems: max,
});
const oneOf = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] });

export const JSON_SCHEMAS: Record<AIFeatureName, { name: string; schema: Schema }> = {
  IDEAS: {
    name: 'content_ideas',
    schema: obj({
      ideas: arr(
        obj({
          title: str(5, 120),
          angle: str(10, 400),
          hook: str(5, 200),
          format: oneOf(['short', 'long', 'tutorial', 'vlog', 'interview', 'review']),
          keywords: arr(str(1, 40), 1, 10),
          rationale: str(0, 400),
        }),
        3,
        10,
      ),
    }),
  },

  TITLES: {
    name: 'video_titles',
    schema: obj({
      titles: arr(
        obj({
          text: str(10, 100),
          style: oneOf(['curiosity', 'howto', 'listicle', 'emotional', 'direct']),
          reasoning: str(0, 280),
          estimatedStrength: int(1, 5),
        }),
        5,
        10,
      ),
    }),
  },

  DESCRIPTION: {
    name: 'video_description',
    schema: obj({
      description: str(50, 5000),
      hashtags: arr(str(2, 60), 0, 15),
      chapters: {
        anyOf: [
          arr(
            obj({
              timestamp: { type: 'string', pattern: '^\\d{1,2}:\\d{2}(:\\d{2})?$' },
              label: str(0, 100),
            }),
            0,
            30,
          ),
          { type: 'null' },
        ],
      },
    }),
  },

  SCRIPT: {
    name: 'video_script',
    schema: obj({
      hook: str(10, 1000),
      sections: arr(obj({ heading: str(0, 120), body: str(20, 6000) }), 1, 20),
      callToAction: str(0, 600),
      estimatedDurationSeconds: int(15, 7200),
    }),
  },

  PLAN: {
    name: 'content_plan',
    schema: obj({
      summary: str(0, 1200),
      cadence: str(0, 200),
      entries: arr(
        obj({
          week: int(1, 52),
          title: str(5, 120),
          format: str(0, 40),
          goal: str(0, 300),
        }),
        1,
        52,
      ),
    }),
  },
};
