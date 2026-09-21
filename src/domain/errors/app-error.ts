import { ERROR_DEFINITIONS, type ErrorCode } from './error-code';

export type ErrorParams = Record<string, string | number | boolean | null>;

export interface AppErrorOptions {
  /** Overrides the default i18n key for this code. */
  messageKey?: string;
  /** Interpolation values for the i18n key. MUST NOT contain sensitive data. */
  params?: ErrorParams;
  /** The underlying failure. Logged in full, never serialised to the client. */
  cause?: unknown;
  /** Internal note for logs only. Never reaches a response body. */
  detail?: string;
  /** Field-level issues for VALIDATION_FAILED. */
  issues?: ValidationIssue[];
  /** Seconds until a retry may succeed, for 429 responses. */
  retryAfterSeconds?: number;
}

export interface ValidationIssue {
  path: string;
  messageKey: string;
  message: string;
}

/**
 * The single error type crossing every layer boundary.
 *
 * The rule that matters: `message` is for developers and logs. What a user sees
 * comes from `messageKey` + `params`, translated on the client. Nothing in
 * `cause` or `detail` is ever serialised into a response.
 *
 * docs/architecture/04-api-architecture.md §4.3–4.4
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly messageKey: string;
  readonly params: ErrorParams;
  readonly retryable: boolean;
  readonly logLevel: 'warn' | 'error';
  readonly detail: string | undefined;
  readonly issues: ValidationIssue[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERROR_DEFINITIONS[code];
    super(options.detail ?? code, options.cause ? { cause: options.cause } : undefined);

    this.name = 'AppError';
    this.code = code;
    this.status = definition.status;
    this.messageKey = options.messageKey ?? definition.messageKey;
    this.params = options.params ?? {};
    this.retryable = definition.retryable;
    this.logLevel = definition.logLevel;
    this.detail = options.detail;
    this.issues = options.issues;
    this.retryAfterSeconds = options.retryAfterSeconds;

    Error.captureStackTrace?.(this, AppError);
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }

  /**
   * The safe, client-facing shape. Deliberately excludes `cause`, `detail`,
   * `stack` and `message` — a snapshot test asserts this stays true.
   */
  toClientJSON(requestId: string) {
    return {
      code: this.code,
      messageKey: this.messageKey,
      params: this.params,
      requestId,
      retryable: this.retryable,
      ...(this.issues ? { issues: this.issues } : {}),
    };
  }
}

/* Constructors for the codes used often enough that a helper pays for itself. */

export const unauthenticated = (detail?: string) =>
  new AppError('UNAUTHENTICATED', detail ? { detail } : {});

export const notFound = (resource: string) =>
  new AppError('NOT_FOUND', { detail: `${resource} not found or not owned by caller` });

export const forbidden = (detail?: string) => new AppError('FORBIDDEN', detail ? { detail } : {});

export const conflict = (messageKey: string, params?: ErrorParams) =>
  new AppError('CONFLICT', params ? { messageKey, params } : { messageKey });

export const notImplemented = (what: string) =>
  new AppError('NOT_IMPLEMENTED', {
    detail: `${what} is not implemented yet`,
    params: { feature: what },
  });

export const internal = (detail: string, cause?: unknown) =>
  new AppError('INTERNAL', cause !== undefined ? { detail, cause } : { detail });

/**
 * Normalises anything thrown into an AppError. Unknown throws become INTERNAL
 * so no upstream message, SQL fragment or stack trace can reach a user.
 */
export function toAppError(error: unknown): AppError {
  if (AppError.is(error)) return error;
  if (error instanceof Error) return internal(error.message, error);
  return internal('Non-Error value thrown', error);
}
