import type { AIFeature } from '@prisma/client';

import { prisma } from '@/db/prisma';
import { aiGenerationRepository } from '@/db/repositories/ai-generation.repository';
import { aiUsageRepository } from '@/db/repositories/ai-usage.repository';
import { auditRepository } from '@/db/repositories/audit.repository';
import { allowancePeriodStart, allowanceResetsAt } from '@/domain/ai/features';
import { AI_FEATURES, ContentIdeasOutput } from '@/domain/ai/types';
import { AppError, notFound } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';

/** Remaining allowance per feature this month. */
export async function getUsage(userId: string, now = new Date()) {
  const periodStart = allowancePeriodStart(now);
  const [limits, used] = await Promise.all([
    aiUsageRepository.monthlyLimits(userId),
    aiUsageRepository.countsFor(userId, periodStart),
  ]);
  return ok({
    resetsAt: allowanceResetsAt(now).toISOString(),
    features: AI_FEATURES.map((feature) => {
      const limit = limits[feature] ?? 0;
      const count = used[feature] ?? 0;
      return { feature, limit, used: count, remaining: Math.max(0, limit - count) };
    }),
  });
}

export async function getGeneration(userId: string, generationId: string) {
  const row = await aiGenerationRepository.findForUser(userId, generationId);
  return row ? ok(row) : err(notFound('generation'));
}

export async function listGenerations(userId: string, limit = 20) {
  return ok(await aiGenerationRepository.listForUser(userId, Math.min(Math.max(limit, 1), 50)));
}

/**
 * Saves one idea from an IDEAS generation as a ContentIdea, keeping the
 * provenance link. The idea is read from the STORED output — the client only
 * says which one — so a user cannot save text the model never produced under
 * the AI's name.
 */
export async function saveIdea(input: {
  userId: string;
  generationId: string;
  index: number;
}): Promise<Result<{ ideaId: string; alreadySaved: boolean }>> {
  const generation = await aiGenerationRepository.findForUser(input.userId, input.generationId);
  if (!generation || generation.feature !== ('IDEAS' satisfies AIFeature))
    return err(notFound('generation'));
  if (generation.status !== 'OK') {
    return err(new AppError('CONFLICT', { detail: 'generation did not succeed' }));
  }

  const parsed = ContentIdeasOutput.safeParse(generation.outputJson);
  const idea = parsed.success ? parsed.data.ideas[input.index] : undefined;
  if (!idea) return err(notFound('idea'));

  const existing = await prisma.contentIdea.findFirst({
    where: { userId: input.userId, aiGenerationId: generation.id, title: idea.title },
    select: { id: true },
  });
  if (existing) return ok({ ideaId: existing.id, alreadySaved: true });

  const saved = await prisma.contentIdea.create({
    data: {
      userId: input.userId,
      channelId: generation.channelId,
      title: idea.title,
      angle: idea.angle,
      hook: idea.hook,
      format: idea.format,
      keywords: idea.keywords,
      rationale: idea.rationale,
      source: 'AI',
      aiGenerationId: generation.id,
    },
    select: { id: true },
  });
  await auditRepository.record({
    userId: input.userId,
    action: 'content.idea.saved',
    resourceType: 'ContentIdea',
    resourceId: saved.id,
  });
  return ok({ ideaId: saved.id, alreadySaved: false });
}
