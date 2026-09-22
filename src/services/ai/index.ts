import 'server-only';

import { AppError } from '@/domain/errors/app-error';
import { SecretString } from '@/domain/shared/secret';
import { env } from '@/lib/env';

import type { AIService } from './ai-service';
import { OpenAIProvider } from './openai.provider';

/**
 * Provider factory. Use cases depend on `getAIService()`, never on a concrete
 * provider. Without configuration it throws CONFIGURATION_MISSING — it never
 * falls back to fixture output.
 */

let service: AIService | undefined;

export function getAIService(): AIService {
  if (service) return service;

  if (env.AI_PROVIDER === 'disabled') {
    throw new AppError('CONFIGURATION_MISSING', {
      messageKey: 'errors.ai.notConfigured',
      detail: 'AI_PROVIDER=disabled',
    });
  }
  if (!env.OPENAI_API_KEY) {
    throw new AppError('CONFIGURATION_MISSING', {
      messageKey: 'errors.ai.notConfigured',
      detail: 'OPENAI_API_KEY is not set',
      params: { setting: 'OPENAI_API_KEY' },
    });
  }

  service = new OpenAIProvider({
    apiKey: new SecretString(env.OPENAI_API_KEY, 'openaiApiKey'),
    fastModel: env.AI_MODEL_FAST,
    strongModel: env.AI_MODEL_STRONG,
  });
  return service;
}

/** Which model a feature uses — for the cache key and the AIGeneration record. */
export function modelFor(tier: 'fast' | 'strong'): string {
  return tier === 'strong' ? env.AI_MODEL_STRONG : env.AI_MODEL_FAST;
}

/** Test hook. */
export function setAIService(next: AIService | undefined): void {
  service = next;
}

export type { AIService } from './ai-service';
