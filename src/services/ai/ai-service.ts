import 'server-only';

import type { Logger } from 'pino';

import type {
  ContentIdeasOutput,
  ContentPlanOutput,
  DescriptionOutput,
  ScriptOutput,
  SupportedLocale,
  TitlesOutput,
} from '@/domain/ai/types';

/**
 * The AI abstraction. Nothing outside this folder knows which provider is used.
 * docs/architecture/07-ai-architecture.md §7.1
 *
 * A provider turns a typed input into a VALIDATED typed output and reports what
 * it cost in tokens. Everything with state — allowances, the spend breaker,
 * caching, the AIGeneration record, persistence — belongs to the application
 * layer (src/modules/ai), which is the only caller.
 *
 * `channelContext` comes exclusively from the context builder in
 * src/modules/ai/context-builder.ts and carries aggregates, never raw YouTube
 * payloads — the compliance boundary in docs/architecture/12 §F.
 */

export interface ChannelContext {
  niche?: string;
  targetAudience?: string;
  brandVoice?: string;
  keywords?: string[];
  postingCadence?: string;
  medianDurationSeconds?: number;
  /** 0..1 — share of recent uploads that are 3 min or less (a length heuristic). */
  shortFormShare?: number;
  /** Titles with performance relative to the channel median — never raw counts. */
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

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** False when the provider did not report usage; cost is then unknown, not 0. */
  reported: boolean;
}

export interface ProviderResult<T> {
  data: T;
  model: string;
  promptVersion: string;
  usage: TokenUsage;
  /** Total provider round trips, including a repair retry. */
  attempts: number;
}

export interface CallOptions {
  log?: Logger;
}

export interface AIService {
  generateContentIdeas(
    input: IdeasInput,
    options?: CallOptions,
  ): Promise<ProviderResult<ContentIdeasOutput>>;
  generateTitles(input: TitlesInput, options?: CallOptions): Promise<ProviderResult<TitlesOutput>>;
  generateDescription(
    input: DescriptionInput,
    options?: CallOptions,
  ): Promise<ProviderResult<DescriptionOutput>>;
  generateScript(input: ScriptInput, options?: CallOptions): Promise<ProviderResult<ScriptOutput>>;
  generateContentPlan(
    input: PlanInput,
    options?: CallOptions,
  ): Promise<ProviderResult<ContentPlanOutput>>;
}
