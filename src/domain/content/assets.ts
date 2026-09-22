import { DescriptionOutput, ScriptOutput, TitlesOutput } from '@/domain/ai/types';

/**
 * Asset kinds, their size limits, and how an AI result becomes asset text.
 *
 * Limits follow what YouTube accepts where it has a limit (title 100,
 * description 5,000 characters) and are otherwise generous but finite, so a
 * project cannot grow without bound.
 */

export const ASSET_KINDS = [
  'TITLE',
  'DESCRIPTION',
  'SCRIPT',
  'TAGS',
  'THUMBNAIL_BRIEF',
  'CHAPTERS',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_MAX_CHARS: Record<AssetKind, number> = {
  TITLE: 100,
  DESCRIPTION: 5_000,
  SCRIPT: 60_000,
  TAGS: 500,
  THUMBNAIL_BRIEF: 2_000,
  CHAPTERS: 3_000,
};

/** Versions kept per kind and locale before the oldest must be dealt with. */
export const MAX_VERSIONS_PER_KIND = 50;

/** Characters as a person counts them (a Khmer or emoji cluster is one), not UTF-16 units. */
export function charCount(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
}

/** Which AI features can feed which asset kind. */
export const FEATURE_TO_KIND = {
  TITLES: 'TITLE',
  DESCRIPTION: 'DESCRIPTION',
  SCRIPT: 'SCRIPT',
} as const satisfies Record<string, AssetKind>;
export type AssetFeature = keyof typeof FEATURE_TO_KIND;

export function isAssetFeature(feature: string): feature is AssetFeature {
  return feature in FEATURE_TO_KIND;
}

/**
 * The text an AI result contributes as an asset, or null when the stored
 * output no longer validates or the pick is out of range. `pick` selects one
 * title from a TITLES result; other features contribute their whole output.
 */
export function assetTextFromOutput(
  feature: AssetFeature,
  output: unknown,
  pick = 0,
): string | null {
  switch (feature) {
    case 'TITLES': {
      const parsed = TitlesOutput.safeParse(output);
      return parsed.success ? (parsed.data.titles[pick]?.text ?? null) : null;
    }
    case 'DESCRIPTION': {
      const parsed = DescriptionOutput.safeParse(output);
      if (!parsed.success) return null;
      // Laid out the way it is pasted into YouTube: text, chapters, hashtags.
      const { description, chapters, hashtags } = parsed.data;
      const blocks = [description.trim()];
      if (chapters && chapters.length > 0) {
        blocks.push(chapters.map((c) => `${c.timestamp} ${c.label}`).join('\n'));
      }
      if (hashtags.length > 0) blocks.push(hashtags.join(' '));
      return blocks.join('\n\n');
    }
    case 'SCRIPT': {
      const parsed = ScriptOutput.safeParse(output);
      if (!parsed.success) return null;
      // No English labels: the script may be in Khmer or Thai. The hook opens
      // it, the call to action closes it, sections keep the model's headings.
      const { hook, sections, callToAction } = parsed.data;
      return [
        hook.trim(),
        ...sections.map(
          (s) => (s.heading.trim() ? `## ${s.heading.trim()}\n` : '') + s.body.trim(),
        ),
        ...(callToAction.trim() ? [callToAction.trim()] : []),
      ].join('\n\n');
    }
  }
}
