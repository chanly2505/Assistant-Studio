import { describe, expect, it } from 'vitest';

import {
  AppError,
  conflict,
  forbidden,
  internal,
  notFound,
  notImplemented,
  toAppError,
  unauthenticated,
} from '@/domain/errors/app-error';
import { ERROR_CODES, ERROR_DEFINITIONS } from '@/domain/errors/error-code';
import { attempt, err, isOk, map, ok, unwrap } from '@/domain/errors/result';
import { SecretString } from '@/domain/shared/secret';

describe('error taxonomy', () => {
  it('defines every code exactly once', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_DEFINITIONS[code]).toBeDefined();
    }
    expect(Object.keys(ERROR_DEFINITIONS)).toHaveLength(ERROR_CODES.length);
  });

  it('maps each code to the documented HTTP status', () => {
    expect(ERROR_DEFINITIONS.UNAUTHENTICATED.status).toBe(401);
    expect(ERROR_DEFINITIONS.FORBIDDEN.status).toBe(403);
    expect(ERROR_DEFINITIONS.NOT_FOUND.status).toBe(404);
    expect(ERROR_DEFINITIONS.VALIDATION_FAILED.status).toBe(422);
    expect(ERROR_DEFINITIONS.RATE_LIMITED.status).toBe(429);
    expect(ERROR_DEFINITIONS.AI_LIMIT_REACHED.status).toBe(429);
    expect(ERROR_DEFINITIONS.YOUTUBE_REAUTH_REQUIRED.status).toBe(409);
    expect(ERROR_DEFINITIONS.INTERNAL.status).toBe(500);
  });

  it('gives every code an i18n key rather than English prose', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_DEFINITIONS[code].messageKey).toMatch(/^errors\./);
      expect(ERROR_DEFINITIONS[code].messageKey).not.toMatch(/\s/);
    }
  });

  it('logs an expired YouTube grant as a warning, not an error', () => {
    // Grants expire and get revoked constantly. Paging someone for it is noise
    // that trains the team to ignore the alert that matters.
    expect(ERROR_DEFINITIONS.YOUTUBE_REAUTH_REQUIRED.logLevel).toBe('warn');
    expect(ERROR_DEFINITIONS.YOUTUBE_QUOTA_EXCEEDED.logLevel).toBe('error');
  });
});

describe('AppError.toClientJSON', () => {
  it('never leaks the cause, the detail, the stack or the message', () => {
    const error = new AppError('INTERNAL', {
      detail: 'connection to postgres://user:hunter2@db:5432 failed',
      cause: new Error('SELECT * FROM "User" WHERE "email" = $1 — relation missing'),
    });

    const payload = error.toClientJSON('req-1');
    const serialised = JSON.stringify(payload);

    expect(Object.keys(payload).sort()).toEqual([
      'code',
      'messageKey',
      'params',
      'requestId',
      'retryable',
    ]);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('postgres://');
    expect(serialised).not.toContain('SELECT');
    expect(serialised).not.toContain('relation missing');
  });

  it('includes validation issues when present', () => {
    const error = new AppError('VALIDATION_FAILED', {
      issues: [{ path: 'body.topic', messageKey: 'errors.validation.too_small', message: 'short' }],
    });

    expect(error.toClientJSON('req-2')).toHaveProperty('issues');
  });
});

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const original = notFound('channel');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps an unknown Error as INTERNAL', () => {
    const wrapped = toAppError(new Error('kaboom'));
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.status).toBe(500);
  });

  it('wraps a thrown non-Error value', () => {
    expect(toAppError('a string was thrown').code).toBe('INTERNAL');
  });
});

describe('Result', () => {
  it('narrows on ok', () => {
    const result = ok({ count: 1 });
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toEqual({ count: 1 });
  });

  it('throws the carried error when unwrapping a failure', () => {
    expect(() => unwrap(err(notFound('video')))).toThrowError(AppError);
  });

  it('converts a throwing promise into a failed Result', async () => {
    const result = await attempt(async () => {
      throw internal('boom');
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL');
  });

  it('wraps a resolving promise as a successful Result', async () => {
    expect(await attempt(async () => 42)).toEqual({ ok: true, data: 42 });
  });

  it('maps over success and passes failure through untouched', () => {
    expect(map(ok(2), (n) => n * 10)).toEqual({ ok: true, data: 20 });

    const failure = err<number>(notFound('x'));
    expect(map(failure, (n) => n * 10)).toBe(failure);
  });
});

describe('error helpers', () => {
  it.each([
    [unauthenticated(), 'UNAUTHENTICATED', 401],
    [unauthenticated('expired'), 'UNAUTHENTICATED', 401],
    [forbidden(), 'FORBIDDEN', 403],
    [forbidden('not owner'), 'FORBIDDEN', 403],
    [conflict('errors.conflict'), 'CONFLICT', 409],
    [conflict('errors.conflict', { channel: 'UC1' }), 'CONFLICT', 409],
    [notImplemented('ai.titles'), 'NOT_IMPLEMENTED', 501],
    [internal('boom', new Error('cause')), 'INTERNAL', 500],
  ])('%o builds %s with status %i', (error, code, status) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it('carries interpolation params for the client', () => {
    expect(conflict('errors.conflict', { channel: 'UC1' }).toClientJSON('r').params).toEqual({
      channel: 'UC1',
    });
  });

  it('allows a module to override the default message key', () => {
    const error = new AppError('UPSTREAM_UNAVAILABLE', { messageKey: 'errors.serviceUnavailable' });
    expect(error.messageKey).toBe('errors.serviceUnavailable');
  });

  it('recognises AppError instances and nothing else', () => {
    expect(AppError.is(notFound('x'))).toBe(true);
    expect(AppError.is(new Error('plain'))).toBe(false);
    expect(AppError.is({ code: 'NOT_FOUND' })).toBe(false);
  });
});

describe('SecretString type guard', () => {
  it('reports length without exposing the value', () => {
    const secret = new SecretString('abcdef');
    expect(secret.length).toBe(6);
    expect(SecretString.is(secret)).toBe(true);
    expect(SecretString.is('abcdef')).toBe(false);
  });
});
