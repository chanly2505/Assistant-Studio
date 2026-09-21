/**
 * The complete error taxonomy.
 * docs/architecture/04-api-architecture.md §4.4
 *
 * Every code carries:
 *   - `status`     the HTTP status the boundary returns
 *   - `messageKey` an i18n key, NOT an English sentence. The server never
 *                  renders prose; the client translates the key.
 *   - `retryable`  whether a client may reasonably retry the same request
 *   - `logLevel`   expected conditions log at `warn`, defects at `error`
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'AI_LIMIT_REACHED',
  'AI_INVALID_OUTPUT',
  'AI_UNAVAILABLE',
  'YOUTUBE_REAUTH_REQUIRED',
  'YOUTUBE_INSUFFICIENT_SCOPE',
  'YOUTUBE_QUOTA_EXCEEDED',
  'YOUTUBE_NO_CHANNEL',
  'OAUTH_DENIED',
  'OAUTH_STATE_INVALID',
  'OAUTH_FAILED',
  'CONFIGURATION_MISSING',
  'UPSTREAM_UNAVAILABLE',
  'NOT_IMPLEMENTED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDefinition {
  status: number;
  messageKey: string;
  retryable: boolean;
  logLevel: 'warn' | 'error';
}

export const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = {
  UNAUTHENTICATED: {
    status: 401,
    messageKey: 'errors.unauthenticated',
    retryable: false,
    logLevel: 'warn',
  },
  FORBIDDEN: {
    status: 403,
    messageKey: 'errors.forbidden',
    retryable: false,
    logLevel: 'warn',
  },
  // Rows owned by another user return 404, never 403 — a 403 would confirm the
  // id exists and hand out a free enumeration oracle. docs/architecture/04 §4.4
  NOT_FOUND: {
    status: 404,
    messageKey: 'errors.notFound',
    retryable: false,
    logLevel: 'warn',
  },
  VALIDATION_FAILED: {
    status: 422,
    messageKey: 'errors.validationFailed',
    retryable: false,
    logLevel: 'warn',
  },
  CONFLICT: {
    status: 409,
    messageKey: 'errors.conflict',
    retryable: false,
    logLevel: 'warn',
  },
  RATE_LIMITED: {
    status: 429,
    messageKey: 'errors.rateLimited',
    retryable: true,
    logLevel: 'warn',
  },
  AI_LIMIT_REACHED: {
    status: 429,
    messageKey: 'errors.ai.limitReached',
    retryable: false,
    logLevel: 'warn',
  },
  AI_INVALID_OUTPUT: {
    status: 502,
    messageKey: 'errors.ai.invalidOutput',
    retryable: true,
    logLevel: 'error',
  },
  AI_UNAVAILABLE: {
    status: 503,
    messageKey: 'errors.ai.unavailable',
    retryable: true,
    logLevel: 'error',
  },
  YOUTUBE_REAUTH_REQUIRED: {
    status: 409,
    messageKey: 'errors.youtube.reauthRequired',
    retryable: false,
    // Expected product state, not a defect: Google grants expire and get revoked.
    logLevel: 'warn',
  },
  YOUTUBE_INSUFFICIENT_SCOPE: {
    status: 403,
    messageKey: 'errors.youtube.insufficientScope',
    retryable: false,
    logLevel: 'warn',
  },
  YOUTUBE_QUOTA_EXCEEDED: {
    status: 503,
    messageKey: 'errors.youtube.quotaExceeded',
    retryable: true,
    logLevel: 'error',
  },
  // The Google account has no YouTube channel (common: a personal Gmail that
  // never created one, or a brand account not selected on the consent screen).
  YOUTUBE_NO_CHANNEL: {
    status: 422,
    messageKey: 'errors.youtube.noChannel',
    retryable: false,
    logLevel: 'warn',
  },
  // The user pressed Cancel on Google's consent screen. Not an error on our side.
  OAUTH_DENIED: {
    status: 400,
    messageKey: 'errors.oauth.denied',
    retryable: false,
    logLevel: 'warn',
  },
  // Missing, expired, reused, or bound to a different user. The last case is an
  // attempted grant injection, which is why this is not merely a 400.
  OAUTH_STATE_INVALID: {
    status: 400,
    messageKey: 'errors.oauth.stateInvalid',
    retryable: false,
    logLevel: 'warn',
  },
  OAUTH_FAILED: {
    status: 502,
    messageKey: 'errors.oauth.failed',
    retryable: true,
    logLevel: 'error',
  },
  // A feature needs configuration this deployment does not have (e.g. Google
  // OAuth credentials in local development). Production cannot reach this:
  // src/lib/env.ts refuses to start without them.
  CONFIGURATION_MISSING: {
    status: 503,
    messageKey: 'errors.configurationMissing',
    retryable: false,
    logLevel: 'warn',
  },
  UPSTREAM_UNAVAILABLE: {
    status: 502,
    messageKey: 'errors.upstreamUnavailable',
    retryable: true,
    logLevel: 'error',
  },
  NOT_IMPLEMENTED: {
    status: 501,
    messageKey: 'errors.notImplemented',
    retryable: false,
    logLevel: 'warn',
  },
  INTERNAL: {
    status: 500,
    messageKey: 'errors.internal',
    retryable: true,
    logLevel: 'error',
  },
};
