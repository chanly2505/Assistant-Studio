import { randomUUID } from 'node:crypto';

import pino, { type Logger } from 'pino';

import { env, config } from '@/lib/env';

import { buildRedactPaths, REDACTED_PLACEHOLDER } from './redaction';

/**
 * Structured server-side logging.
 * docs/architecture/08-security-architecture.md §8.6
 *
 * Every log line carries a correlation id so a user report ("request 01J…
 * failed") maps to the exact request, its outbound API calls and its errors.
 */

export interface RequestContext {
  requestId: string;
  userId?: string;
  route?: string;
  method?: string;
}

const baseLogger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: buildRedactPaths(),
    censor: REDACTED_PLACEHOLDER,
  },
  base: {
    service: 'youtube-studio-assistant',
    env: env.NODE_ENV,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty output locally; JSON everywhere a log drain is reading.
  ...(config.isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,service,env',
          },
        },
      }
    : {}),
});

export const logger = baseLogger;

export function newRequestId(): string {
  return randomUUID();
}

/** A child logger bound to one request. Pass this down, never the base logger. */
export function requestLogger(context: RequestContext): Logger {
  return baseLogger.child(context);
}

/**
 * Records one outbound call to an external API, with the fields needed to debug
 * quota and latency problems. Never receives a token or a request body.
 */
export function logExternalCall(
  log: Logger,
  params: {
    api: 'youtube_data' | 'youtube_analytics' | 'openai' | 'google_oauth';
    operation: string;
    durationMs: number;
    status?: number;
    quotaUnits?: number;
    outcome: 'success' | 'error';
    errorCode?: string;
  },
): void {
  const level = params.outcome === 'success' ? 'info' : 'warn';
  log[level]({ external: params }, `${params.api}.${params.operation}`);
}
