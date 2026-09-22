import type { AIFeatureName } from './types';

/**
 * Per-feature generation settings. docs/architecture/07-ai-architecture.md §7.4
 *
 * `tier` routes to a model by cost/quality fit. `maxOutputTokens` caps spend
 * per call. `promptVersion` is stored on every AIGeneration so any output can
 * be traced to the exact prompt that produced it, and bumping a version never
 * serves a stale cached answer for the new prompt.
 */
export interface FeatureConfig {
  tier: 'fast' | 'strong';
  maxOutputTokens: number;
  promptVersion: string;
}

export const FEATURES: Record<AIFeatureName, FeatureConfig> = {
  IDEAS: { tier: 'fast', maxOutputTokens: 3_000, promptVersion: 'ideas.v1' },
  TITLES: { tier: 'fast', maxOutputTokens: 1_500, promptVersion: 'titles.v1' },
  DESCRIPTION: { tier: 'fast', maxOutputTokens: 2_500, promptVersion: 'description.v1' },
  SCRIPT: { tier: 'strong', maxOutputTokens: 12_000, promptVersion: 'script.v1' },
  PLAN: { tier: 'strong', maxOutputTokens: 6_000, promptVersion: 'plan.v1' },
};

export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  km: 'Khmer (ភាសាខ្មែរ)',
  th: 'Thai (ภาษาไทย)',
  vi: 'Vietnamese (Tiếng Việt)',
  zh: 'Simplified Chinese (简体中文)',
};

/** How long an identical request is answered from the stored result. */
export const CACHE_HOURS = 24;

/** The calendar month an allowance period starts in (UTC). */
export function allowancePeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function allowanceResetsAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
