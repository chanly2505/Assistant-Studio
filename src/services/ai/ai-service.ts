import 'server-only';

import type {
  AIResult,
  ContentIdeasOutput,
  ContentPlanOutput,
  DescriptionOutput,
  ScriptOutput,
  SupportedLocale,
  TitlesOutput,
} from '@/domain/ai/types';

/**
 * The AI abstraction. Nothing outside this folder knows which provider is in use.
 * docs/architecture/07-ai-architecture.md §7.1
 *
 * `channelContext` is produced exclusively by AIContextBuilder (Phase 6) and
 * carries aggregates, never raw YouTube API payloads — the compliance boundary
 * described in docs/architecture/12 §F.
 */

export interface ChannelContext {
  niche?: string;
  targetAudience?: string;
  brandVoice?: string;
  keywords?: string[];
  postingCadence?: string;
  medianDurationSeconds?: number;
  /** Titles with performance expressed relative to the channel median, never raw counts. */
  topTitles?: Array<{ title: string; relativePerformance: number }>;
}

export interface BaseAIInput {
  locale: SupportedLocale;
  channelContext?: ChannelContext;
}

export interface IdeasInput extends BaseAIInput {
  topic: string;
  count?: number;
}

export interface TitlesInput extends BaseAIInput {
  topic: string;
  existingTitle?: string;
}

export interface DescriptionInput extends BaseAIInput {
  title: string;
  summary: string;
  includeChapters?: boolean;
}

export interface ScriptInput extends BaseAIInput {
  title: string;
  outline?: string;
  targetDurationSeconds: number;
}

export interface PlanInput extends BaseAIInput {
  goal: string;
  weeks: number;
}

export interface AIService {
  generateContentIdeas(input: IdeasInput): Promise<AIResult<ContentIdeasOutput>>;
  generateTitles(input: TitlesInput): Promise<AIResult<TitlesOutput>>;
  generateDescription(input: DescriptionInput): Promise<AIResult<DescriptionOutput>>;
  generateScript(input: ScriptInput): Promise<AIResult<ScriptOutput>>;
  generateContentPlan(input: PlanInput): Promise<AIResult<ContentPlanOutput>>;
}
