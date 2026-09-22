import { NextResponse } from 'next/server';
import type { Logger } from 'pino';
import { z, type ZodTypeAny } from 'zod';

import { AppError, toAppError, type ValidationIssue } from '@/domain/errors/app-error';
import type { Result } from '@/domain/errors/result';
import { clientIdentity, getSession, type SessionUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { newRequestId, requestLogger } from '@/lib/logger';

import { getRateLimiter, rateLimitError, type RateLimitRule } from './rate-limit';
import { jsonError, jsonOk, type ResponseMeta } from './responses';

/**
 * The boundary wrapper. Every route handler goes through it; nothing bypasses it.
 * docs/architecture/04-api-architecture.md §4.2
 *
 * Order is deliberate:
 *   correlation id → auth → rate limit → validation → handler → serialise →
 *   error map → access log
 *
 * Rate limiting precedes validation so an attacker cannot use cheap malformed
 * requests to probe at full speed; auth precedes rate limiting so limits key on
 * a user id when there is one.
 */

type AuthMode = 'required' | 'optional' | 'none';

/**
 * `auth: 'required'` guarantees a user, so the handler's `user` is non-nullable
 * for those routes. This removes the `user!` assertions that otherwise appear in
 * every protected route — and with them the chance of one being wrong.
 */
type UserFor<TAuth extends AuthMode> = TAuth extends 'required' ? SessionUser : SessionUser | null;

export interface HandlerContext<TBody, TQuery, TParams, TAuth extends AuthMode> {
  request: Request;
  body: TBody;
  query: TQuery;
  params: TParams;
  user: UserFor<TAuth>;
  requestId: string;
  log: Logger;
}

export interface WithApiOptions<
  TAuth extends AuthMode,
  TBodySchema extends ZodTypeAny | undefined,
  TQuerySchema extends ZodTypeAny | undefined,
  TParamsSchema extends ZodTypeAny | undefined,
> {
  auth: TAuth;
  body?: TBodySchema;
  query?: TQuerySchema;
  params?: TParamsSchema;
  /**
   * Omitted → the default for the method (DEFAULT_READ_LIMIT or
   * DEFAULT_WRITE_LIMIT), so no route is ever unlimited by accident.
   * `false` is the explicit, reviewable opt-out.
   */
  rateLimit?: RateLimitRule | false;
  /** Audit action name, written by the use case. Recorded on the access log. */
  audit?: string;
  /** Success status when the handler returns data. Defaults to 200. */
  successStatus?: number;
  /**
   * For routes a BROWSER navigates to (OAuth callbacks, HTML form posts): on
   * failure, redirect here instead of rendering JSON in the user's tab. Receives
   * the error so the page can show the translated message.
   */
  errorRedirect?: (error: AppError, user: SessionUser | null) => string;
}

/**
 * Every route is rate limited. docs/architecture/08 §8.5: reads 120/min/user.
 * Both fail OPEN: they cost nothing, so availability wins if Redis is down.
 * Routes that cost money (AI) set their own fail-CLOSED rule.
 */
export const DEFAULT_READ_LIMIT: RateLimitRule = {
  key: 'api:read',
  points: 120,
  windowSec: 60,
  onStoreFailure: 'open',
};
export const DEFAULT_WRITE_LIMIT: RateLimitRule = {
  key: 'api:write',
  points: 60,
  windowSec: 60,
  onStoreFailure: 'open',
};

/** Methods that change state and therefore need CSRF protection. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Infer<S> = S extends ZodTypeAny ? z.infer<S> : undefined;

/** Next.js 15 passes route params as a promise. */
type RouteArgs = { params?: Promise<Record<string, string | string[]>> };

/** A handler may return a Result, a plain value, or a NextResponse it built itself. */
type HandlerReturn<T> = Result<T> | NextResponse;

export function withApi<
  TAuth extends AuthMode,
  TBodySchema extends ZodTypeAny | undefined = undefined,
  TQuerySchema extends ZodTypeAny | undefined = undefined,
  TParamsSchema extends ZodTypeAny | undefined = undefined,
  TData = unknown,
>(
  options: WithApiOptions<TAuth, TBodySchema, TQuerySchema, TParamsSchema>,
  handler: (
    context: HandlerContext<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>, TAuth>,
  ) => Promise<HandlerReturn<TData>>,
) {
  return async function route(request: Request, args?: RouteArgs): Promise<NextResponse> {
    const startedAt = Date.now();
    const requestId = request.headers.get('x-request-id') ?? newRequestId();
    const url = new URL(request.url);

    const log = requestLogger({
      requestId,
      route: url.pathname,
      method: request.method,
    });

    let user: SessionUser | null = null;

    try {
      /* 0. CSRF: a state-changing request must come from our own origin. ---- */
      // Browsers attach Origin to every cross-origin request and to same-origin
      // POSTs. An absent Origin is a non-browser client, which cannot ride on a
      // victim's cookies anyway. SameSite=Lax is the first line; this is the second.
      if (UNSAFE_METHODS.has(request.method)) {
        const origin = request.headers.get('origin');
        if (origin && origin !== new URL(env.APP_URL).origin) {
          throw new AppError('FORBIDDEN', {
            detail: `cross-origin ${request.method} from ${origin}`,
          });
        }
      }

      /* 1. Authentication ------------------------------------------------- */
      if (options.auth !== 'none') {
        const session = await getSession(request);
        user = session?.user ?? null;

        if (options.auth === 'required' && !user) {
          throw new AppError('UNAUTHENTICATED', { detail: 'no session for a protected route' });
        }
      }

      /* 2. Rate limiting --------------------------------------------------- */
      const rule =
        options.rateLimit === false
          ? null
          : (options.rateLimit ??
            (UNSAFE_METHODS.has(request.method) ? DEFAULT_WRITE_LIMIT : DEFAULT_READ_LIMIT));
      if (rule) {
        const identity = user ? `user:${user.id}` : clientIdentity(request);
        let result;
        try {
          result = await getRateLimiter().consume(rule, identity);
        } catch (storeError) {
          const mode = rule.onStoreFailure ?? 'closed';
          log.error({ err: storeError }, 'rate limiter unavailable');
          if (mode === 'closed') {
            throw new AppError('UPSTREAM_UNAVAILABLE', {
              detail: 'rate limiter unavailable; failing closed',
              cause: storeError,
            });
          }
          result = { allowed: true, remaining: 0, limit: 0, resetSeconds: 0 };
        }

        if (!result.allowed) throw rateLimitError(result);
      }

      /* 3. Validation ------------------------------------------------------ */
      const rawParams = args?.params ? await args.params : {};
      const params = parse(options.params, rawParams, 'params');
      const query = parse(options.query, Object.fromEntries(url.searchParams), 'query');
      const body = options.body ? parse(options.body, await readJson(request), 'body') : undefined;

      /* 4. Handler --------------------------------------------------------- */
      const outcome = await handler({
        request,
        body: body as Infer<TBodySchema>,
        query: query as Infer<TQuerySchema>,
        params: params as Infer<TParamsSchema>,
        user: user as UserFor<TAuth>,
        requestId,
        log,
      });

      // A handler that built its own response (streaming, redirects) is passed through.
      if (outcome instanceof Response) {
        logAccess(log, {
          status: outcome.status,
          startedAt,
          userId: user?.id,
          audit: options.audit,
        });
        return outcome as NextResponse;
      }

      if (!outcome.ok) throw outcome.error;

      const meta: ResponseMeta = { requestId };
      const response = jsonOk(outcome.data, meta, { status: options.successStatus ?? 200 });
      logAccess(log, {
        status: response.status,
        startedAt,
        userId: user?.id,
        audit: options.audit,
      });
      return response;
    } catch (thrown) {
      const error = toAppError(thrown);

      log[error.logLevel](
        {
          // `errorCode`, not `code`: `code` is redacted everywhere because an
          // OAuth authorization code is a live credential, and logging our error
          // code under that key silently erased it from every error line.
          err: {
            name: error.name,
            errorCode: error.code,
            detail: error.detail,
            cause: error.cause,
          },
          userId: user?.id,
          audit: options.audit,
        },
        `request failed: ${error.code}`,
      );

      if (options.errorRedirect) {
        const location = options.errorRedirect(error, user);
        logAccess(log, { status: 303, startedAt, userId: user?.id, audit: options.audit });
        return NextResponse.redirect(new URL(location, env.APP_URL), 303);
      }

      logAccess(log, { status: error.status, startedAt, userId: user?.id, audit: options.audit });
      return jsonError(error, requestId);
    }
  };
}

/* -------------------------------------------------------------------------- */

function parse<S extends ZodTypeAny | undefined>(
  schema: S,
  value: unknown,
  source: 'body' | 'query' | 'params',
): Infer<S> {
  if (!schema) return undefined as Infer<S>;

  const result = schema.safeParse(value);
  if (result.success) return result.data as Infer<S>;

  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: [source, ...issue.path.map(String)].join('.'),
    messageKey: `errors.validation.${issue.code}`,
    message: issue.message,
  }));

  throw new AppError('VALIDATION_FAILED', {
    issues,
    detail: `${source} failed validation`,
  });
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'expected content-type: application/json',
      issues: [
        {
          path: 'headers.content-type',
          messageKey: 'errors.validation.contentType',
          message: 'Expected application/json',
        },
      ],
    });
  }

  try {
    return await request.json();
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'request body is not valid JSON',
      cause,
      issues: [
        {
          path: 'body',
          messageKey: 'errors.validation.invalidJson',
          message: 'Request body is not valid JSON',
        },
      ],
    });
  }
}

function logAccess(
  log: Logger,
  params: { status: number; startedAt: number; userId?: string; audit?: string },
): void {
  log.info(
    {
      http: { status: params.status, durationMs: Date.now() - params.startedAt },
      userId: params.userId,
      audit: params.audit,
    },
    'request completed',
  );
}
