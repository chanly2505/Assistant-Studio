/**
 * Fields that must never appear in a log line.
 * docs/architecture/08-security-architecture.md §8.6
 *
 * `tests/unit/lib/logger.test.ts` feeds an object containing every one of these
 * through the real logger and asserts none of the values survive. The list is a
 * tested contract, not a comment.
 */
export const REDACTED_KEYS = [
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'code',
  'code_verifier',
  'codeVerifier',
  'client_secret',
  'clientSecret',
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apiKey',
  'password',
  'sessionToken',
  'encryptedRefreshToken',
  'TOKEN_ENCRYPTION_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'AUTH_SECRET',
  'DATABASE_URL',
  // Personal data: log a salted hash or an opaque id instead.
  'email',
  'ip',
  'ipAddress',
] as const;

export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * Containers we actually log into. pino's `redact.paths` is path-based, not a
 * deep key scan, so each key is registered under every realistic parent.
 */
const CONTAINERS = ['', '*.', 'req.', 'res.', 'req.headers.', 'res.headers.', 'err.', 'context.'];

export function buildRedactPaths(): string[] {
  const paths = new Set<string>();

  for (const key of REDACTED_KEYS) {
    // Keys containing a dash or dot must be bracket-quoted in a pino path.
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;

    for (const container of CONTAINERS) {
      paths.add(
        segment.startsWith('[')
          ? `${container.replace(/\.$/, '')}${segment}`
          : `${container}${segment}`,
      );
    }
  }

  return [...paths].filter((path) => path.length > 0);
}
