/**
 * Runs AFTER setup.ts (vitest.config order), so the environment is loaded
 * before these imports evaluate src/lib/env.ts.
 *
 * Default: jobs are recorded, not sent to Redis. Queue tests that need the real
 * thing construct BullMQJobQueue themselves.
 */
import { beforeEach } from 'vitest';

import { setJobQueue } from '@/services/queue';

import { recordingQueue } from './queue';

setJobQueue(recordingQueue);
beforeEach(() => recordingQueue.clear());
