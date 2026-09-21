import 'server-only';

import type { AIService } from './ai-service';
import { NotImplementedAIProvider } from './providers/not-implemented.provider';

/**
 * Provider factory. Use cases depend on `getAIService()`, never on a concrete
 * provider, so Phase 6 swaps the implementation without touching a call site.
 */

let service: AIService = new NotImplementedAIProvider();

export function getAIService(): AIService {
  return service;
}

/** Used by the composition root at boot, and by tests. */
export function setAIService(next: AIService): void {
  service = next;
}

export type { AIService } from './ai-service';
