import { describe, expect, it } from 'vitest';

import { parseEnv } from '@/lib/env';

/**
 * A missing variable must crash at boot with a readable message, not surface
 * inside a request at 3am. docs/architecture/08-security-architecture.md §8.1
 */

const minimal = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5433/studio_assistant',
};

const productionBase = {
  NODE_ENV: 'production',
  APP_URL: 'https://app.example.com',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app',
  AUTH_SECRET: 'a'.repeat(32),
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  REDIS_URL: 'redis://cache.example.com:6379',
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test',
};

describe('parseEnv', () => {
  it('applies defaults in development', () => {
    const env = parseEnv(minimal);

    expect(env.LOG_LEVEL).toBe('info');
    expect(env.AI_PROVIDER).toBe('mock');
    expect(env.YOUTUBE_DATA_DAILY_QUOTA).toBe(10_000);
  });

  it('rejects a missing DATABASE_URL with a named message', () => {
    expect(() => parseEnv({ NODE_ENV: 'development' })).toThrowError(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not postgres', () => {
    expect(() =>
      parseEnv({ ...minimal, DATABASE_URL: 'mysql://user:pass@localhost:3306/app' }),
    ).toThrowError(/DATABASE_URL/);
  });

  it('accepts a complete production configuration', () => {
    expect(() => parseEnv(productionBase)).not.toThrow();
  });

  it.each([
    'AUTH_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'REDIS_URL',
  ])('requires %s in production', (key) => {
    const incomplete = { ...productionBase, [key]: undefined };
    expect(() => parseEnv(incomplete)).toThrowError(new RegExp(key));
  });

  it('refuses the mock AI provider in production', () => {
    expect(() => parseEnv({ ...productionBase, AI_PROVIDER: 'mock' })).toThrowError(/AI_PROVIDER/);
  });

  it('requires an API key when the OpenAI provider is selected', () => {
    expect(() =>
      parseEnv({ ...minimal, AI_PROVIDER: 'openai', OPENAI_API_KEY: undefined }),
    ).toThrowError(/OPENAI_API_KEY/);
  });

  it('rejects a token encryption key that is not exactly 32 bytes', () => {
    expect(() =>
      parseEnv({ ...productionBase, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrowError(/TOKEN_ENCRYPTION_KEY/);
  });

  describe('during `next build`', () => {
    const buildOnly = {
      NODE_ENV: 'production',
      NEXT_PHASE: 'phase-production-build',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/app',
    };

    it('builds without runtime secrets, so CI never needs production credentials', () => {
      expect(() => parseEnv(buildOnly)).not.toThrow();
    });

    it('still validates the shape of what is present', () => {
      expect(() => parseEnv({ ...buildOnly, DATABASE_URL: 'not-a-url' })).toThrowError(
        /DATABASE_URL/,
      );
      expect(() =>
        parseEnv({ ...buildOnly, TOKEN_ENCRYPTION_KEY: Buffer.alloc(8).toString('base64') }),
      ).toThrowError(/TOKEN_ENCRYPTION_KEY/);
    });

    it('enforces secrets again once the server starts', () => {
      // `next start` reports phase-production-server, not the build phase.
      expect(() => parseEnv({ ...buildOnly, NEXT_PHASE: 'phase-production-server' })).toThrowError(
        /AUTH_SECRET/,
      );
    });
  });

  it('accepts a 32-byte key', () => {
    expect(() =>
      parseEnv({ ...productionBase, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }),
    ).not.toThrow();
  });
});
