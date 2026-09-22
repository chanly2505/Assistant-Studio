import { createHash } from 'node:crypto';

import type { AIFeature, AIGenerationStatus, Prisma } from '@prisma/client';
import type { Logger } from 'pino';

import { aiGenerationRepository } from '@/db/repositories/ai-generation.repository';
import { aiUsageRepository } from '@/db/repositories/ai-usage.repository';
import { auditRepository } from '@/db/repositories/audit.repository';
import { channelRepository } from '@/db/repositories/channel.repository';
import {
  CACHE_HOURS,
  FEATURES,
  allowancePeriodStart,
  allowanceResetsAt,
} from '@/domain/ai/features';
import type { SupportedLocale } from '@/domain/ai/types';
import { AppError, notFound, toAppError } from '@/domain/errors/app-error';
import { err, ok, type Result } from '@/domain/errors/result';
import { env } from '@/lib/env';
import { logger as rootLogger } from '@/lib/logger';
import { getAIService, modelFor } from '@/services/ai';
import type { AIService, ChannelContext, ProviderResult } from '@/services/ai/ai-service';
import { billedUsageOf } from '@/services/ai/openai.provider';
import { costMicros, maxCostMicros } from '@/services/ai/pricing';

import { buildChannelContext } from './context-builder';

/**
 * The single pipeline every AI feature runs through.
 * docs/architecture/07-ai-architecture.md §7.2
 *
 *   1. authorise        the channel, if given, belongs to the caller
 *   2. cache            an identical successful request in the last 24 h is
 *                       returned as-is: no provider call, no allowance used
 *   3. spend breaker    platform-wide daily AI spend cap
 *   4. allowance        ONE atomic reservation against the monthly plan limit
 *   5. record PENDING   before the call, so a crash still leaves a record
 *   6. provider call    validated structured output (one repair retry inside)
 *   7. finalise         tokens, cost, latency, outcome; refund the allowance
 *                       if the user did not get a result
 *
 * Allowance policy: a use is charged only when the user receives a result.
 * Refusals, provider errors and invalid output are refunded. Their COST is
 * still recorded and counts toward the spend breaker — that protects us, the
 * allowance protects the user.
 */

export interface GenerationOutcome<T> {
  generationId: string;
  data: T;
  cached: boolean;
  model: string;
  /** Uses left this month for this feature, after this one. */
  remaining: number;
  resetsAt: string;
}

interface Job<T> {
  userId: string;
  feature: AIFeature;
  locale: SupportedLocale;
  channelId?: string | undefined;
  /** User-authored input only — stored for history and hashed for caching. */
  input: Record<string, unknown>;
  call: (
    service: AIService,
    context: ChannelContext | undefined,
    log: Logger,
  ) => Promise<ProviderResult<T>>;
  log?: Logger;
  now?: Date;
}

export async function runGeneration<T>(job: Job<T>): Promise<Result<GenerationOutcome<T>>> {
  const log = (job.log ?? rootLogger).child({ aiFeature: job.feature });
  const now = job.now ?? new Date();
  const config = FEATURES[job.feature];
  const model = modelFor(config.tier);
  const periodStart = allowancePeriodStart(now);
  const resetsAt = allowanceResetsAt(now).toISOString();

  /* 1. Authorise --------------------------------------------------------- */
  if (job.channelId) {
    const channel = await channelRepository.findForUser(job.userId, job.channelId);
    if (!channel || channel.disconnectedAt) return err(notFound('channel'));
  }

  // Resolve the provider BEFORE reserving anything: a missing key must not
  // burn allowance or leave PENDING rows behind.
  let service: AIService;
  try {
    service = getAIService();
  } catch (error) {
    return err(toAppError(error));
  }

  const context = job.channelId ? await buildChannelContext(job.userId, job.channelId) : undefined;

  const limits = await aiUsageRepository.monthlyLimits(job.userId);
  const limit = limits[job.feature] ?? 0;

  /* 2. Cache ------------------------------------------------------------- */
  const inputHash = hashInput({
    feature: job.feature,
    promptVersion: config.promptVersion,
    model,
    locale: job.locale,
    input: job.input,
    context: context ?? null,
  });
  const cached = await aiGenerationRepository.findCached(
    job.userId,
    job.feature,
    inputHash,
    new Date(now.getTime() - CACHE_HOURS * 3_600_000),
  );
  if (cached?.outputJson) {
    const used = (await aiUsageRepository.countsFor(job.userId, periodStart))[job.feature] ?? 0;
    return ok({
      generationId: cached.id,
      data: cached.outputJson as T,
      cached: true,
      model: cached.model,
      remaining: Math.max(0, limit - used),
      resetsAt,
    });
  }

  /* 3. Spend breaker ---------------------------------------------------- */
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const spentToday = await aiGenerationRepository.spendSince(dayStart);
  if (spentToday >= env.AI_DAILY_SPEND_LIMIT_MICROS) {
    log.error({ spentToday }, 'AI daily spend limit reached; refusing new generations');
    return err(
      new AppError('AI_UNAVAILABLE', {
        detail: `daily AI spend limit reached (${spentToday} micros)`,
      }),
    );
  }

  /* 4. Allowance -------------------------------------------------------- */
  const count = await aiUsageRepository.reserve(job.userId, job.feature, periodStart, limit);
  if (count === null) {
    return err(
      new AppError('AI_LIMIT_REACHED', {
        detail: `${job.feature} monthly limit ${limit} reached`,
        params: { resetAt: resetsAt, limit },
      }),
    );
  }

  /* 5. Record PENDING --------------------------------------------------- */
  const generationId = await aiGenerationRepository.createPending({
    userId: job.userId,
    channelId: job.channelId ?? null,
    feature: job.feature,
    provider: 'openai',
    model,
    promptVersion: config.promptVersion,
    locale: job.locale,
    inputHash,
    inputJson: job.input as Prisma.InputJsonValue,
  });

  /* 6. Call -------------------------------------------------------------- */
  const startedAt = Date.now();
  try {
    const result = await job.call(service, context, log);
    const cost = costMicros(result.model, result.usage);
    const costKnown = cost !== null;
    const recordedCost = cost ?? maxCostMicros(result.model, config.maxOutputTokens);

    /* 7. Finalise -------------------------------------------------------- */
    await aiGenerationRepository.finalize(generationId, {
      status: 'OK',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costMicros: recordedCost,
      costKnown,
      latencyMs: Date.now() - startedAt,
      outputJson: result.data as Prisma.InputJsonValue,
    });
    await aiUsageRepository.addSpend(
      job.userId,
      job.feature,
      periodStart,
      result.usage.inputTokens + result.usage.outputTokens,
      recordedCost,
    );
    await auditRepository.record({
      userId: job.userId,
      action: `ai.${job.feature.toLowerCase()}.generated`,
      resourceType: 'AIGeneration',
      resourceId: generationId,
      metadata: { model: result.model, attempts: result.attempts, costKnown },
    });
    if (!costKnown)
      log.warn({ model: result.model }, 'AI cost unknown; recorded the per-call maximum');

    return ok({
      generationId,
      data: result.data,
      cached: false,
      model: result.model,
      remaining: Math.max(0, limit - count),
      resetsAt,
    });
  } catch (thrown) {
    const error = toAppError(thrown);
    // A refused or invalid answer was still generated — and billed. Record the
    // real tokens when the provider reported them. With no report (network
    // failure, 5xx, 429) nothing was generated, so nothing was billed.
    const billed = billedUsageOf(error);
    const billedCost = billed ? costMicros(billed.model, billed.usage) : null;
    await aiGenerationRepository.finalize(generationId, {
      status: statusFor(error),
      inputTokens: billed?.usage.inputTokens ?? 0,
      outputTokens: billed?.usage.outputTokens ?? 0,
      costMicros: billed ? (billedCost ?? maxCostMicros(billed.model, config.maxOutputTokens)) : 0,
      costKnown: billed ? billedCost !== null : true,
      latencyMs: Date.now() - startedAt,
      errorCode: error.code,
    });
    await aiUsageRepository.refund(job.userId, job.feature, periodStart);
    log[error.logLevel](
      { err: { errorCode: error.code, detail: error.detail } },
      'AI generation failed',
    );
    return err(error);
  }
}

/** Stable across key order, so the same request always hashes the same. */
export function hashInput(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function statusFor(error: AppError): Exclude<AIGenerationStatus, 'PENDING' | 'OK'> {
  if (error.code === 'AI_REFUSED') return 'FILTERED';
  if (error.code === 'AI_INVALID_OUTPUT') return 'INVALID_OUTPUT';
  if (error.code === 'UPSTREAM_UNAVAILABLE' && /timed out/.test(error.detail ?? ''))
    return 'TIMEOUT';
  return 'PROVIDER_ERROR';
}

/**
 * Sweeper for PENDING rows left by a process that died mid-call: marks them
 * failed and refunds the allowance each reserved. Runs on the hourly tick.
 */
export async function sweepAbandonedGenerations(now = new Date()): Promise<number> {
  const stale = await aiGenerationRepository.abandoned(new Date(now.getTime() - 15 * 60_000));
  let swept = 0;
  for (const row of stale) {
    if (!row.userId) continue;
    if (await aiGenerationRepository.markAbandoned(row.id)) {
      await aiUsageRepository.refund(row.userId, row.feature, allowancePeriodStart(row.createdAt));
      swept += 1;
    }
  }
  return swept;
}
