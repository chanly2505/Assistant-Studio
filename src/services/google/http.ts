import 'server-only';

import type { Logger } from 'pino';

import { AppError } from '@/domain/errors/app-error';
import { logExternalCall, logger as rootLogger } from '@/lib/logger';

/**
 * The single path for outbound calls to Google. No client calls `fetch` itself.
 * docs/architecture/06-youtube-integration-architecture.md §6.1, §6.5
 *
 * Owns: timeout, network-failure translation, response parsing and one
 * structured log line per call (api, operation, status, duration, quota units —
 * never a URL with a token in it, never a body).
 */

export type GoogleApi = 'google_oauth' | 'youtube_data' | 'youtube_analytics';
/** The same helper serves OpenAI: one place for timeouts, failures and logging. */
export type ExternalApi = GoogleApi | 'openai';

export interface GoogleRequest {
  api: ExternalApi;
  operation: string;
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
  quotaUnits?: number;
  log?: Logger;
}

export interface GoogleResponse {
  status: number;
  ok: boolean;
  body: unknown;
  retryAfterSeconds?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function googleRequest(request: GoogleRequest): Promise<GoogleResponse> {
  const log = request.log ?? rootLogger;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(request.url, { ...request.init, signal: controller.signal });
  } catch (cause) {
    const timedOut = controller.signal.aborted;
    logExternalCall(log, {
      api: request.api,
      operation: request.operation,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      errorCode: timedOut ? 'timeout' : 'network_error',
    });
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `${request.api}.${request.operation} ${timedOut ? 'timed out' : 'network error'}`,
      cause,
      params: { service: request.api === 'openai' ? 'openai' : 'google' },
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await readBody(response);
  const retryAfter = Number(response.headers.get('retry-after'));

  logExternalCall(log, {
    api: request.api,
    operation: request.operation,
    durationMs: Date.now() - startedAt,
    status: response.status,
    ...(request.quotaUnits !== undefined ? { quotaUnits: request.quotaUnits } : {}),
    outcome: response.ok ? 'success' : 'error',
    ...(response.ok ? {} : { errorCode: errorReason(body) ?? `http_${response.status}` }),
  });

  return {
    status: response.status,
    ok: response.ok,
    body,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a proxy, typically. Keep only its length — the
    // content can echo request details back.
    return { unparseable: true, length: text.length };
  }
}

/**
 * Pulls the machine-readable reason out of either Google error shape:
 *   OAuth endpoints: { error: "invalid_grant", error_description }
 *   Data/Analytics:  { error: { code, message, errors: [{ reason }] } }
 */
export function errorReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;

  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const errors = (error as { errors?: Array<{ reason?: unknown }> }).errors;
    const reason = errors?.[0]?.reason;
    if (typeof reason === 'string') return reason;
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'string') return status;
  }
  return undefined;
}

/** Key names only — enough to debug a schema change, nothing that leaks data. */
export function describeShape(body: unknown): string {
  if (body === null || typeof body !== 'object') return typeof body;
  return `{${Object.keys(body as object).join(',')}}`;
}

/** Alias for non-Google callers, so call sites read correctly. */
export const externalRequest = googleRequest;
