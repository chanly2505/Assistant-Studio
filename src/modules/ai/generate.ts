import type { AIFeature } from '@prisma/client';
import type { Logger } from 'pino';

import type {
  ContentIdeasOutput,
  ContentPlanOutput,
  DescriptionOutput,
  ScriptOutput,
  TitlesOutput,
} from '@/domain/ai/types';
import type { Result } from '@/domain/errors/result';

import type {
  DescriptionRequest,
  IdeasRequest,
  PlanRequest,
  ScriptRequest,
  TitlesRequest,
} from './inputs';
import { runGeneration, type GenerationOutcome } from './run-generation';

/**
 * The five AI features. Each is a thin mapping from a validated request to the
 * shared pipeline in run-generation.ts; none has logic of its own to diverge.
 */

type Caller = { userId: string; log?: Logger };

export function generateIdeas(
  caller: Caller,
  request: IdeasRequest,
): Promise<Result<GenerationOutcome<ContentIdeasOutput>>> {
  const { channelId, locale, ...input } = request;
  return runGeneration({
    ...caller,
    feature: 'IDEAS',
    locale,
    channelId,
    input,
    call: (ai, context, log) =>
      ai.generateContentIdeas(
        { ...input, locale, ...(context ? { channelContext: context } : {}) },
        { log },
      ),
  });
}

export function generateTitles(
  caller: Caller,
  request: TitlesRequest,
): Promise<Result<GenerationOutcome<TitlesOutput>>> {
  const { channelId, locale, ...input } = request;
  return runGeneration({
    ...caller,
    feature: 'TITLES',
    locale,
    channelId,
    input,
    call: (ai, context, log) =>
      ai.generateTitles(
        { ...input, locale, ...(context ? { channelContext: context } : {}) },
        { log },
      ),
  });
}

export function generateDescription(
  caller: Caller,
  request: DescriptionRequest,
): Promise<Result<GenerationOutcome<DescriptionOutput>>> {
  const { channelId, locale, ...input } = request;
  return runGeneration({
    ...caller,
    feature: 'DESCRIPTION',
    locale,
    channelId,
    input,
    call: (ai, context, log) =>
      ai.generateDescription(
        { ...input, locale, ...(context ? { channelContext: context } : {}) },
        { log },
      ),
  });
}

export function generateScript(
  caller: Caller,
  request: ScriptRequest,
): Promise<Result<GenerationOutcome<ScriptOutput>>> {
  const { channelId, locale, targetMinutes, ...rest } = request;
  return runGeneration({
    ...caller,
    feature: 'SCRIPT',
    locale,
    channelId,
    input: { ...rest, targetMinutes },
    call: (ai, context, log) =>
      ai.generateScript(
        {
          ...rest,
          targetDurationSeconds: targetMinutes * 60,
          locale,
          ...(context ? { channelContext: context } : {}),
        },
        { log },
      ),
  });
}

export function generatePlan(
  caller: Caller,
  request: PlanRequest,
): Promise<Result<GenerationOutcome<ContentPlanOutput>>> {
  const { channelId, locale, ...input } = request;
  return runGeneration({
    ...caller,
    feature: 'PLAN',
    locale,
    channelId,
    input,
    call: (ai, context, log) =>
      ai.generateContentPlan(
        { ...input, locale, ...(context ? { channelContext: context } : {}) },
        { log },
      ),
  });
}

export const FEATURE_BY_SLUG: Record<string, AIFeature> = {
  ideas: 'IDEAS',
  titles: 'TITLES',
  description: 'DESCRIPTION',
  script: 'SCRIPT',
  plan: 'PLAN',
};
