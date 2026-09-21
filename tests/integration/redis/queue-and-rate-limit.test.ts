import { randomBytes } from 'node:crypto';

import { QueueEvents, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SecretString } from '@/domain/shared/secret';
import { RedisRateLimiter } from '@/lib/api/rate-limit';
import { logger } from '@/lib/logger';
import { REDIS_PREFIX, createRedis } from '@/lib/redis';
import { clearAccessTokenCache, primeAccessToken } from '@/modules/youtube/access-token';
import { getTokenVault } from '@/services/crypto';
import { BullMQJobQueue } from '@/services/queue';
import { QUEUE_NAME } from '@/services/queue/jobs';
import { processJob } from '@/worker/processor';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import { googleServer, resetGoogle, videoItem, youtubeCatalog } from '../../helpers/google';

/**
 * Against the REAL Redis-compatible server (Valkey, db 1, prefix ysa-test).
 * `pnpm redis:start` must be running.
 */

let redis: Redis;

beforeAll(async () => {
  googleServer.listen({ onUnhandledRequest: 'error' });
  redis = createRedis('cache');
  expect(await redis.ping()).toBe('PONG');
  // Refuse to run against anything but the test prefix: FLUSHDB below is total.
  expect(REDIS_PREFIX).toBe('ysa-test');
});
beforeEach(async () => {
  await redis.flushdb();
  await resetDatabase();
  await testPrisma.plan.createMany({
    data: [{ key: 'free', name: 'Free', maxChannels: 1, monthlyGenerations: {} }],
    skipDuplicates: true,
  });
  clearAccessTokenCache();
});
afterEach(() => resetGoogle());
afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
  googleServer.close();
  await disconnectDatabase();
});

describe('RedisRateLimiter', () => {
  it('admits exactly the limit under concurrency (atomic Lua)', async () => {
    const limiter = new RedisRateLimiter(redis);
    const rule = { key: 'test:burst', points: 5, windowSec: 60 };

    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.consume(rule, 'user:1')),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.find((r) => !r.allowed)?.resetSeconds).toBeGreaterThan(0);
  });

  it('shares state across limiter instances — i.e. across servers', async () => {
    const a = new RedisRateLimiter(redis);
    const b = new RedisRateLimiter(redis);
    const rule = { key: 'test:shared', points: 2, windowSec: 60 };

    await a.consume(rule, 'user:1');
    await b.consume(rule, 'user:1');
    expect((await a.consume(rule, 'user:1')).allowed).toBe(false);
  });

  it('keeps identities and rules apart', async () => {
    const limiter = new RedisRateLimiter(redis);
    const rule = { key: 'test:apart', points: 1, windowSec: 60 };
    await limiter.consume(rule, 'user:1');

    expect((await limiter.consume(rule, 'user:2')).allowed).toBe(true);
    expect((await limiter.consume({ ...rule, key: 'test:other' }, 'user:1')).allowed).toBe(true);
  });

  it('expires its keys, so idle identities do not accumulate', async () => {
    const limiter = new RedisRateLimiter(redis);
    await limiter.consume({ key: 'test:ttl', points: 3, windowSec: 60 }, 'user:1');
    const ttl = await redis.pttl(`${REDIS_PREFIX}:rl:test:ttl:user:1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});

describe('BullMQ queue + worker (real Valkey)', () => {
  it('collapses repeated enqueues of the same work into one job', async () => {
    const queue = new BullMQJobQueue();
    try {
      const payload = {
        userId: 'u',
        channelId: 'c1',
        mode: 'delta' as const,
        trigger: 'manual' as const,
      };
      for (let i = 0; i < 5; i += 1) await queue.enqueue('channel.videos', payload);

      expect(await queue.raw.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    } finally {
      await queue.raw.obliterate({ force: true });
      await queue.close();
    }
  });

  it('refuses a malformed payload at enqueue time, before it reaches Redis', async () => {
    const queue = new BullMQJobQueue();
    try {
      await expect(queue.enqueue('channel.videos', { channelId: 'c1' } as never)).rejects.toThrow();
      expect(await queue.raw.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
    } finally {
      await queue.close();
    }
  });

  it('a real worker picks up a queued sync and writes the videos', async () => {
    const user = await createTestUser();
    const id = `conn_${randomBytes(4).toString('hex')}`;
    await testPrisma.youTubeConnection.create({
      data: {
        id,
        userId: user.id,
        googleSub: `sub-${id}`,
        googleEmail: 'c@example.test',
        encryptedRefreshToken: getTokenVault().encrypt(new SecretString('1//rt'), id),
        scopes: [],
      },
    });
    const channel = await testPrisma.youTubeChannel.create({
      data: {
        connectionId: id,
        userId: user.id,
        youtubeChannelId: `UC_${id}`,
        title: 'C',
        uploadsPlaylistId: `UU_${id}`,
      },
    });
    primeAccessToken(id, new SecretString('ya29.warm'), 3600);
    googleServer.use(...youtubeCatalog(['a1', 'a2'], [videoItem('a1'), videoItem('a2')]));

    const queue = new BullMQJobQueue();
    const events = new QueueEvents(QUEUE_NAME, {
      connection: createRedis('queue'),
      prefix: REDIS_PREFIX,
    });
    const worker = new Worker(
      QUEUE_NAME,
      (job) => processJob(job.name, job.data, job.attemptsMade + 1, logger),
      {
        connection: createRedis('queue'),
        prefix: REDIS_PREFIX,
      },
    );

    try {
      await events.waitUntilReady();
      const done = new Promise<unknown>((resolve, reject) => {
        events.on('completed', ({ returnvalue }) => resolve(returnvalue));
        events.on('failed', ({ failedReason }) => reject(new Error(failedReason)));
      });

      await queue.enqueue('channel.videos', {
        userId: user.id,
        channelId: channel.id,
        mode: 'full',
        trigger: 'connect',
      });

      await done;
      expect(await testPrisma.youTubeVideo.count({ where: { channelId: channel.id } })).toBe(2);
      const job = await testPrisma.syncJob.findFirstOrThrow({ where: { channelId: channel.id } });
      expect(job).toMatchObject({ status: 'SUCCEEDED', jobType: 'CHANNEL_BACKFILL' });
    } finally {
      await worker.close();
      await events.close();
      await queue.raw.obliterate({ force: true });
      await queue.close();
    }
  }, 20_000);
});
