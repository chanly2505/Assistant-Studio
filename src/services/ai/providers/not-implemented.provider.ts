import 'server-only';

import { notImplemented } from '@/domain/errors/app-error';
import type { AIService } from '@/services/ai/ai-service';

/**
 * Phase 2 placeholder.
 *
 * It throws NOT_IMPLEMENTED rather than returning plausible-looking fixture
 * data. A stub that returns fake ideas makes the UI look finished and hides the
 * fact that nothing is wired up — exactly the failure mode the brief rules out.
 * The route exists, the contract is typed, and the honest answer is 501.
 *
 * Replaced by OpenAIProvider in Phase 6; the mock provider used by tests lives
 * in tests/helpers and is never reachable from production code.
 */
export class NotImplementedAIProvider implements AIService {
  async generateContentIdeas(): Promise<never> {
    throw notImplemented('ai.ideas');
  }

  async generateTitles(): Promise<never> {
    throw notImplemented('ai.titles');
  }

  async generateDescription(): Promise<never> {
    throw notImplemented('ai.description');
  }

  async generateScript(): Promise<never> {
    throw notImplemented('ai.script');
  }

  async generateContentPlan(): Promise<never> {
    throw notImplemented('ai.plan');
  }
}
