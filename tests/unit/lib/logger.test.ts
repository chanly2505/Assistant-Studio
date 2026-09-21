import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { SecretString } from '@/domain/shared/secret';
import { REDACTED_KEYS, REDACTED_PLACEHOLDER, buildRedactPaths } from '@/lib/logger/redaction';

/**
 * The redaction list is a tested contract, not a comment.
 * docs/architecture/08-security-architecture.md §8.6
 */

function captureLog(write: (log: pino.Logger) => void): string {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  const logger = pino(
    { redact: { paths: buildRedactPaths(), censor: REDACTED_PLACEHOLDER } },
    sink,
  );

  write(logger);
  return chunks.join('');
}

describe('log redaction', () => {
  const canary = 'CANARY-SECRET-VALUE-9f2a';

  it.each(REDACTED_KEYS)('redacts "%s" at the top level', (key) => {
    const output = captureLog((log) => log.info({ [key]: canary }, 'test'));

    expect(output).not.toContain(canary);
    expect(output).toContain(REDACTED_PLACEHOLDER);
  });

  it.each(REDACTED_KEYS)('redacts "%s" one level deep', (key) => {
    const output = captureLog((log) => log.info({ context: { [key]: canary } }, 'test'));
    expect(output).not.toContain(canary);
  });

  it('redacts an OAuth token exchange payload wholesale', () => {
    const output = captureLog((log) =>
      log.info(
        {
          context: {
            access_token: 'ya29.REAL_ACCESS_TOKEN',
            refresh_token: '1//REAL_REFRESH_TOKEN',
            id_token: 'eyJREAL.ID.TOKEN',
            code_verifier: 'verifier-value',
            email: 'creator@example.com',
          },
        },
        'token exchange',
      ),
    );

    expect(output).not.toContain('ya29.');
    expect(output).not.toContain('1//REAL_REFRESH_TOKEN');
    expect(output).not.toContain('eyJREAL');
    expect(output).not.toContain('verifier-value');
    expect(output).not.toContain('creator@example.com');
  });

  it('keeps the application error code in error lines', () => {
    // Regression: logged as `err.code` it matched the OAuth-code redaction rule
    // and every error line read "code":"[redacted]".
    const output = captureLog((log) =>
      log.error({ err: { errorCode: 'UPSTREAM_UNAVAILABLE', code: 'oauth-code-value' } }, 'x'),
    );

    expect(output).toContain('UPSTREAM_UNAVAILABLE');
    expect(output).not.toContain('oauth-code-value');
  });

  it('still logs the fields that make a line useful', () => {
    const output = captureLog((log) =>
      log.info({ requestId: 'req-42', userId: 'user-7', quotaUnits: 21 }, 'sync complete'),
    );

    expect(output).toContain('req-42');
    expect(output).toContain('user-7');
    expect(output).toContain('21');
  });
});

describe('SecretString', () => {
  const secret = new SecretString('1//super-secret-refresh-token', 'refreshToken');

  it('hides the value from string interpolation', () => {
    expect(`${secret}`).toBe('[redacted]');
  });

  it('hides the value from JSON.stringify', () => {
    expect(JSON.stringify({ token: secret })).not.toContain('super-secret');
  });

  it('hides the value from a logger even under a key that is not on the redact list', () => {
    const output = captureLog((log) =>
      log.info({ someUnlistedField: new SecretString('1//leak-me', 'token') }, 'test'),
    );

    expect(output).not.toContain('leak-me');
  });

  it('returns the real value only through expose()', () => {
    expect(secret.expose()).toBe('1//super-secret-refresh-token');
  });
});
