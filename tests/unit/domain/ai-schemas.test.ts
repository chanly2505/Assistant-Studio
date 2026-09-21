import { describe, expect, it } from 'vitest';

import {
  ContentIdeasOutput,
  ContentPlanOutput,
  DescriptionOutput,
  OUTPUT_SCHEMA_BY_FEATURE,
  AI_FEATURES,
  ScriptOutput,
  TitlesOutput,
} from '@/domain/ai/types';

/**
 * These schemas are what the rest of the system trusts about model output.
 * Provider-side structured output is a strong constraint, not a guarantee —
 * a model can still return a truncated array, an extra key, or a string where
 * a number belongs. docs/architecture/07-ai-architecture.md §7.3
 */

const validTitle = (text: string) => ({
  text,
  style: 'howto' as const,
  reasoning: 'Clear promise of a practical outcome.',
  estimatedStrength: 4,
});

const fiveTitles = [
  'How to Brew Cambodian Iced Coffee at Home',
  'The Street Food Stall Locals Queue For',
  '7 Dishes You Must Try in Phnom Penh',
  'I Ate Only Street Food for a Week',
  'Why This Noodle Soup Starts at 5am',
].map(validTitle);

describe('schema registry', () => {
  it('has an output schema for every AI feature', () => {
    for (const feature of AI_FEATURES) {
      expect(OUTPUT_SCHEMA_BY_FEATURE[feature]).toBeDefined();
    }
  });
});

describe('TitlesOutput', () => {
  it('accepts a well-formed response', () => {
    expect(TitlesOutput.safeParse({ titles: fiveTitles }).success).toBe(true);
  });

  it('rejects fewer than five titles — a truncated response', () => {
    expect(TitlesOutput.safeParse({ titles: fiveTitles.slice(0, 4) }).success).toBe(false);
  });

  it('rejects a title YouTube would truncate (over 100 characters)', () => {
    const tooLong = [...fiveTitles.slice(0, 4), validTitle('x'.repeat(101))];
    expect(TitlesOutput.safeParse({ titles: tooLong }).success).toBe(false);
  });

  it('rejects a strength score outside 1-5', () => {
    const bad = [
      ...fiveTitles.slice(0, 4),
      { ...validTitle('A perfectly fine title'), estimatedStrength: 9 },
    ];
    expect(TitlesOutput.safeParse({ titles: bad }).success).toBe(false);
  });

  it('rejects a strength score the model returned as a string', () => {
    const bad = [
      ...fiveTitles.slice(0, 4),
      { ...validTitle('A perfectly fine title'), estimatedStrength: '4' },
    ];
    expect(TitlesOutput.safeParse({ titles: bad }).success).toBe(false);
  });

  it('rejects an unknown style', () => {
    const bad = [
      ...fiveTitles.slice(0, 4),
      { ...validTitle('A perfectly fine title'), style: 'clickbait' },
    ];
    expect(TitlesOutput.safeParse({ titles: bad }).success).toBe(false);
  });

  it('rejects extra top-level keys the model invented', () => {
    expect(TitlesOutput.safeParse({ titles: fiveTitles, note: 'hope this helps!' }).success).toBe(
      false,
    );
  });
});

describe('ContentIdeasOutput', () => {
  const idea = {
    title: 'Morning market tour',
    angle: 'Follow a vendor from 4am setup to the lunch rush.',
    hook: 'Most tourists never see this.',
    format: 'vlog' as const,
    keywords: ['market', 'phnom penh'],
    rationale: 'Behind-the-scenes content performs well for local-food channels.',
  };

  it('accepts three to ten ideas', () => {
    expect(ContentIdeasOutput.safeParse({ ideas: [idea, idea, idea] }).success).toBe(true);
  });

  it('rejects an idea with no keywords', () => {
    expect(
      ContentIdeasOutput.safeParse({ ideas: [idea, idea, { ...idea, keywords: [] }] }).success,
    ).toBe(false);
  });

  it('rejects an unknown format', () => {
    expect(
      ContentIdeasOutput.safeParse({ ideas: [idea, idea, { ...idea, format: 'podcast' }] }).success,
    ).toBe(false);
  });
});

describe('DescriptionOutput', () => {
  const description = 'A '.repeat(40) + 'description long enough to be useful.';

  it('accepts hashtags in non-Latin scripts', () => {
    // Khmer, Thai and Chinese hashtags must validate — this app targets them.
    const result = DescriptionOutput.safeParse({
      description,
      hashtags: ['#streetfood', '#ម្ហូបខ្មែរ', '#อาหารไทย', '#美食'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a hashtag without the leading #', () => {
    expect(DescriptionOutput.safeParse({ description, hashtags: ['streetfood'] }).success).toBe(
      false,
    );
  });

  it('rejects a hashtag containing a space', () => {
    expect(DescriptionOutput.safeParse({ description, hashtags: ['#street food'] }).success).toBe(
      false,
    );
  });

  // Built from code points so the invisible characters are visible in review.
  it.each([
    ['no-break space', 0x00a0],
    ['zero-width space', 0x200b],
    ['ideographic space', 0x3000],
    ['C1 control character', 0x0080],
  ])('rejects a hashtag containing a %s', (_name, codePoint) => {
    const hashtag = `#street${String.fromCodePoint(codePoint)}food`;
    expect(DescriptionOutput.safeParse({ description, hashtags: [hashtag] }).success).toBe(false);
  });

  it('accepts a Khmer hashtag whose vowels are combining marks', () => {
    // ម្ហូប contains U+17D2 (coeng) and U+17BC — both category Mn, not letters.
    const khmer = '#ម្ហូបខ្មែរ';
    expect([...khmer].some((char) => /\p{M}/u.test(char))).toBe(true);
    expect(DescriptionOutput.safeParse({ description, hashtags: [khmer] }).success).toBe(true);
  });

  it('accepts well-formed chapter timestamps', () => {
    const result = DescriptionOutput.safeParse({
      description,
      hashtags: [],
      chapters: [
        { timestamp: '0:00', label: 'Intro' },
        { timestamp: '12:34', label: 'The stall' },
        { timestamp: '1:02:03', label: 'Verdict' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed chapter timestamp', () => {
    expect(
      DescriptionOutput.safeParse({
        description,
        hashtags: [],
        chapters: [{ timestamp: '1m30s', label: 'Intro' }],
      }).success,
    ).toBe(false);
  });
});

describe('ScriptOutput', () => {
  const script = {
    hook: 'You have walked past this stall a hundred times.',
    sections: [{ heading: 'Setup', body: 'At four in the morning the charcoal is already lit.' }],
    callToAction: 'Subscribe for the next market.',
    estimatedDurationSeconds: 480,
  };

  it('accepts a well-formed script', () => {
    expect(ScriptOutput.safeParse(script).success).toBe(true);
  });

  it('rejects a script with no sections', () => {
    expect(ScriptOutput.safeParse({ ...script, sections: [] }).success).toBe(false);
  });

  it('rejects an implausible duration', () => {
    expect(ScriptOutput.safeParse({ ...script, estimatedDurationSeconds: 5 }).success).toBe(false);
    expect(ScriptOutput.safeParse({ ...script, estimatedDurationSeconds: 99_999 }).success).toBe(
      false,
    );
  });
});

describe('ContentPlanOutput', () => {
  const plan = {
    summary: 'Four weeks building a local-food audience.',
    cadence: 'Two videos per week',
    entries: [{ week: 1, title: 'Best breakfast stalls', format: 'long', goal: 'Establish niche' }],
  };

  it('accepts a well-formed plan', () => {
    expect(ContentPlanOutput.safeParse(plan).success).toBe(true);
  });

  it('rejects a week number outside the year', () => {
    expect(
      ContentPlanOutput.safeParse({ ...plan, entries: [{ ...plan.entries[0], week: 53 }] }).success,
    ).toBe(false);
  });
});
