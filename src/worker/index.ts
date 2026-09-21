/**
 * The background worker: a long-lived process, separate from the web server.
 * docs/architecture/01-system-architecture.md §1.3, 10 §10.3
 *
 *   pnpm worker        (production-style)
 *   pnpm worker:dev    (restarts on file change)
 *
 * Run with `--conditions=react-server` (the package scripts do): the shared
 * modules import `server-only`, which throws under Node's default condition.
 */
import { Worker } from 'bullmq';

import { prisma } from '@/db/prisma';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { REDIS_PREFIX, createRedis } from '@/lib/redis';
import { BullMQJobQueue, setJobQueue } from '@/services/queue';
import { QUEUE_NAME } from '@/services/queue/jobs';

import { processJob } from './processor';

const log = logger.child({ component: 'worker' });

async function main(): Promise<void> {
  const queue = new BullMQJobQueue();
  setJobQueue(queue);
  await queue.ensureScheduler();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt: job.attemptsMade + 1 });
      jobLog.info('job started');
      return processJob(job.name, job.data, job.attemptsMade + 1, jobLog);
    },
    {
      connection: createRedis('queue'),
      prefix: REDIS_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
      // A job not heart-beating for 60 s (crashed process) is handed to another worker.
      stalledInterval: 60_000,
    },
  );

  worker.on('failed', (job, error) => {
    log.warn(
      { jobId: job?.id, jobName: job?.name, attempts: job?.attemptsMade, message: error.message },
      'job failed',
    );
  });
  worker.on('error', (error) => log.error({ message: error.message }, 'worker error'));

  log.info(
    { queue: QUEUE_NAME, prefix: REDIS_PREFIX, concurrency: env.WORKER_CONCURRENCY },
    'worker ready',
  );

  // Graceful shutdown: stop taking jobs, let in-flight ones finish, then exit.
  // Deploys send SIGTERM; 60 s is the grace period in docs/architecture/10 §10.5.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker shutting down');
    const force = setTimeout(() => process.exit(1), 60_000);
    await worker.close();
    await queue.close();
    await prisma.$disconnect();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  log.fatal(
    { message: error instanceof Error ? error.message : String(error) },
    'worker failed to start',
  );
  process.exit(1);
});
