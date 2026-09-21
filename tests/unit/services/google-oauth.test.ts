import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_CONNECT_SCOPES,
  LOGIN_SCOPES,
  REQUIRED_YOUTUBE_SCOPES,
  YOUTUBE_ANALYTICS_READONLY,
  YOUTUBE_READONLY,
  missingScopes,
  parseScopes,
} from '@/domain/youtube/scopes';
import { errorReason, describeShape } from '@/services/google/http';
import {
  buildAuthorizationUrl,
  createPkce,
  createState,
  readIdToken,
} from '@/services/google/oauth';
import { classifyYouTubeError } from '@/services/youtube/youtube-data.client';

import { CLIENT_ID, idToken } from '../../helpers/google';

describe('scopes: the two grants stay separate', () => {
  it('asks for identity only at sign-in — never YouTube', () => {
    // docs/architecture/05 §5.1. Asking for analytics on the sign-up screen is a
    // conversion killer and widens the blast radius of a revoked login.
    expect([...LOGIN_SCOPES]).toEqual(['openid', 'email', 'profile']);
    for (const scope of LOGIN_SCOPES) expect(scope).not.toMatch(/youtube|yt-analytics/);
  });

  it('asks for read-only YouTube access at channel connect — never write scopes', () => {
    expect(CHANNEL_CONNECT_SCOPES).toContain(YOUTUBE_READONLY);
    expect(CHANNEL_CONNECT_SCOPES).toContain(YOUTUBE_ANALYTICS_READONLY);
    for (const scope of CHANNEL_CONNECT_SCOPES) {
      expect(scope).not.toMatch(/force-ssl|youtube\.upload|auth\/youtube$/);
    }
  });

  it('reports each required scope the user unticked', () => {
    expect(missingScopes([YOUTUBE_READONLY])).toEqual([YOUTUBE_ANALYTICS_READONLY]);
    expect(missingScopes([...REQUIRED_YOUTUBE_SCOPES, 'openid'])).toEqual([]);
    expect(missingScopes([])).toEqual([...REQUIRED_YOUTUBE_SCOPES]);
  });

  it('parses Google’s space-separated scope string', () => {
    expect(parseScopes(`openid  ${YOUTUBE_READONLY}\n`)).toEqual(['openid', YOUTUBE_READONLY]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('PKCE and state', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('produces a verifier within RFC 7636 limits, URL-safe', () => {
    const { verifier } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats a state value', () => {
    const states = new Set(Array.from({ length: 200 }, createState));
    expect(states.size).toBe(200);
  });
});

describe('buildAuthorizationUrl', () => {
  const url = new URL(
    buildAuthorizationUrl({ state: 'st', codeChallenge: 'ch', loginHint: 'a@b.c' }),
  );
  const param = (key: string) => url.searchParams.get(key);

  it('targets Google with our client and registered redirect', () => {
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(param('client_id')).toBe(CLIENT_ID);
    expect(param('redirect_uri')).toBe('http://localhost:3000/api/youtube/oauth/callback');
  });

  it('asks for a refresh token every time', () => {
    expect(param('access_type')).toBe('offline');
    expect(param('prompt')).toContain('consent');
  });

  it('uses PKCE with S256', () => {
    expect(param('code_challenge')).toBe('ch');
    expect(param('code_challenge_method')).toBe('S256');
    expect(param('state')).toBe('st');
  });

  it('does not merge in the sign-in grant', () => {
    // Merging would make "disconnect channel" revoke sign-in consent as well.
    expect(param('include_granted_scopes')).toBeNull();
  });
});

describe('readIdToken', () => {
  it('returns the identity with a lowercased email', () => {
    expect(readIdToken(idToken(), CLIENT_ID)).toEqual({
      sub: 'google-sub-1',
      email: 'creator@example.com',
    });
  });

  it('rejects a token minted for a different client', () => {
    expect(() => readIdToken(idToken({ aud: 'someone-else' }), CLIENT_ID)).toThrowError(
      expect.objectContaining({ code: 'OAUTH_FAILED' }),
    );
  });

  it('rejects a foreign issuer', () => {
    expect(() => readIdToken(idToken({ iss: 'https://evil.example' }), CLIENT_ID)).toThrowError(
      /issuer/,
    );
  });

  it('rejects malformed tokens', () => {
    expect(() => readIdToken('not-a-jwt', CLIENT_ID)).toThrowError(/malformed/);
    expect(() => readIdToken('a.bm90LWpzb24.c', CLIENT_ID)).toThrowError(/not JSON/);
    expect(() => readIdToken(idToken({ sub: undefined }), CLIENT_ID)).toThrowError(/incomplete/);
  });
});

describe('Google error parsing', () => {
  it('reads the OAuth error shape', () => {
    expect(errorReason({ error: 'invalid_grant', error_description: 'Bad Request' })).toBe(
      'invalid_grant',
    );
  });

  it('reads the Data API error shape', () => {
    expect(errorReason({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } })).toBe(
      'quotaExceeded',
    );
    expect(errorReason({ error: { status: 'PERMISSION_DENIED' } })).toBe('PERMISSION_DENIED');
  });

  it('copes with bodies that are not Google errors', () => {
    expect(errorReason(null)).toBeUndefined();
    expect(errorReason('oops')).toBeUndefined();
  });

  it('describes a payload by key names only', () => {
    expect(describeShape({ items: [], secret: 'value' })).toBe('{items,secret}');
    expect(describeShape(null)).toBe('object');
  });
});

describe('classifyYouTubeError', () => {
  const response = (status: number, reason?: string, retryAfterSeconds?: number) => ({
    status,
    ok: false,
    body: reason ? { error: { code: status, errors: [{ reason }] } } : null,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  });

  it.each([
    [401, undefined, 'YOUTUBE_REAUTH_REQUIRED'],
    [403, 'quotaExceeded', 'YOUTUBE_QUOTA_EXCEEDED'],
    [403, 'dailyLimitExceeded', 'YOUTUBE_QUOTA_EXCEEDED'],
    [403, 'insufficientPermissions', 'YOUTUBE_INSUFFICIENT_SCOPE'],
    [403, 'rateLimitExceeded', 'UPSTREAM_UNAVAILABLE'],
    [403, 'forbidden', 'FORBIDDEN'],
    [404, 'channelNotFound', 'NOT_FOUND'],
    [429, undefined, 'UPSTREAM_UNAVAILABLE'],
    [500, undefined, 'UPSTREAM_UNAVAILABLE'],
    [503, 'backendError', 'UPSTREAM_UNAVAILABLE'],
    [400, 'badRequest', 'UPSTREAM_UNAVAILABLE'],
  ])('%i %s → %s', (status, reason, expected) => {
    expect(classifyYouTubeError(response(status, reason), 'channels.list').code).toBe(expected);
  });

  it('carries Retry-After through', () => {
    expect(classifyYouTubeError(response(429, undefined, 30), 'x').retryAfterSeconds).toBe(30);
  });
});
