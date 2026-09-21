import { z } from 'zod';

/**
 * Every background job, with its payload contract.
 * docs/architecture/10-deployment-architecture.md §10.4
 *
 * Payloads carry ids only — never tokens, never user content. They sit in
 * Redis in plaintext and appear in queue dashboards.
 */

export const QUEUE_NAME = 'youtube-sync';

const Trigger = z.enum(['connect', 'manual', 'schedule']);
const Ids = { userId: z.string().min(1), channelId: z.string().min(1) };

export const JOB_SCHEMAS = {
  /** Walk the uploads playlist: `full` visits every page, `delta` stops at known videos. */
  'channel.videos': z
    .object({ ...Ids, mode: z.enum(['full', 'delta']), trigger: Trigger })
    .strict(),
  /** Refresh statistics for videos whose tier makes them due. */
  'channel.video-stats': z.object({ ...Ids, trigger: Trigger }).strict(),
  /** Channel-level counters (subscribers, views, video count). */
  'channel.stats': z.object({ ...Ids, trigger: Trigger }).strict(),
  /** Hourly: find channels that are due and enqueue their jobs. */
  'schedule.tick': z.object({}).strict(),
} as const;

export type JobName = keyof typeof JOB_SCHEMAS;
export type JobPayload<N extends JobName> = z.infer<(typeof JOB_SCHEMAS)[N]>;

/**
 * Deterministic job ids make enqueueing idempotent: while a job with this id is
 * waiting, delayed or running, adding it again is a no-op. Five clicks on
 * "Refresh" produce one sync, not five.
 *
 * (BullMQ forbids ':' in custom ids, hence the separator.)
 */
export function jobIdFor<N extends JobName>(name: N, payload: JobPayload<N>): string {
  switch (name) {
    case 'channel.videos': {
      const p = payload as JobPayload<'channel.videos'>;
      return `${name}__${p.channelId}__${p.mode}`;
    }
    case 'channel.video-stats':
    case 'channel.stats':
      return `${name}__${(payload as { channelId: string }).channelId}`;
    default:
      return name;
  }
}
