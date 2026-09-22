import 'server-only';

import IORedis, { type Redis } from 'ioredis';

import { AppError } from '@/domain/errors/app-error';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Redis (or Valkey) connections.
 *
 * Two profiles, because they need opposite failure behaviour:
 *   queue — BullMQ REQUIRES maxRetriesPerRequest: null. Commands wait through a
 *           reconnect instead of failing, so no job is lost on a blip.
 *   cache — rate limiting must fail FAST so a request is not held hostage by a
 *           slow Redis; the caller then fails open or closed per rule.
 */

export type RedisPurpose = 'queue' | 'cache';

export function isRedisConfigured(): boolean {
  return Boolean(env.REDIS_URL);
}

export function createRedis(purpose: RedisPurpose): Redis {
  if (!env.REDIS_URL) {
    throw new AppError('CONFIGURATION_MISSING', {
      detail: 'REDIS_URL is not set',
      params: { setting: 'REDIS_URL' },
    });
  }

  const client = new IORedis(env.REDIS_URL, {
    connectionName: `ysa-${purpose}`,
    ...(purpose === 'queue'
      ? { maxRetriesPerRequest: null, enableReadyCheck: true }
      : { maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 1_000 }),
  });

  client.on('error', (error) => {
    // ioredis emits on every failed reconnect attempt; log at warn, once per
    // distinct message, without the URL (it may carry a password).
    logger.warn({ redis: { purpose, message: error.message } }, 'redis connection error');
  });

  return client;
}

let cacheClient: Redis | undefined;

/** Shared, fail-fast client for rate limiting. */
export function getCacheRedis(): Redis {
  cacheClient ??= createRedis('cache');
  return cacheClient;
}

/** Namespaces every key, so tests and environments sharing a server never collide. */
export const REDIS_PREFIX = env.REDIS_KEY_PREFIX;
