import type { Adapter, AdapterAccount, AdapterUser } from 'next-auth/adapters';
import { describe, expect, it, vi } from 'vitest';

import { hardenAdapter, stripTokens } from '@/lib/auth/adapter';
import { SESSION_COOKIE_NAME, readCookie } from '@/lib/auth/cookies';
import { errorRedirectPath, flashCodeFor, localePath } from '@/lib/i18n/paths';

describe('hardenAdapter', () => {
  const account: AdapterAccount = {
    userId: 'u1',
    type: 'oidc',
    provider: 'google',
    providerAccountId: 'google-sub-1',
    access_token: 'ya29.LOGIN_ACCESS',
    refresh_token: '1//LOGIN_REFRESH',
    id_token: 'eyJ.LOGIN.ID',
    expires_at: 1_900_000_000,
    session_state: 'state',
    token_type: 'bearer',
    scope: 'openid email profile',
  };

  function fakeBase() {
    return {
      createUser: vi.fn(async (user: AdapterUser) => user),
      getUserByEmail: vi.fn(async (_email: string) => null),
      linkAccount: vi.fn(async (a: AdapterAccount) => a),
      getSessionAndUser: vi.fn(),
    } satisfies Partial<Adapter>;
  }

  it('never passes Google login tokens to the database', async () => {
    const base = fakeBase();
    await hardenAdapter(base as Adapter).linkAccount!(account);

    const stored = base.linkAccount.mock.calls[0]?.[0] as AdapterAccount;
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain('LOGIN_ACCESS');
    expect(serialised).not.toContain('LOGIN_REFRESH');
    expect(serialised).not.toContain('LOGIN.ID');
    // The identity link itself is kept.
    expect(stored).toMatchObject({ provider: 'google', providerAccountId: 'google-sub-1' });
  });

  it('lowercases email on create and on lookup', async () => {
    const base = fakeBase();
    const adapter = hardenAdapter(base as Adapter);

    await adapter.createUser!({ id: 'x', email: 'Alice@Example.COM', emailVerified: null });
    await adapter.getUserByEmail!('ALICE@example.com');

    expect(base.createUser.mock.calls[0]?.[0].email).toBe('alice@example.com');
    expect(base.getUserByEmail.mock.calls[0]?.[0]).toBe('alice@example.com');
  });

  it('leaves every other adapter method untouched', () => {
    const base = fakeBase();
    expect(hardenAdapter(base as Adapter).getSessionAndUser).toBe(base.getSessionAndUser);
  });

  it('strips tokens without mutating the input', () => {
    stripTokens(account);
    expect(account.access_token).toBe('ya29.LOGIN_ACCESS');
  });
});

describe('Auth.js Google provider', () => {
  it('requests identity scopes only', async () => {
    const { googleProvider } = await import('@/lib/auth/auth');
    const options = (
      googleProvider as unknown as { options: { authorization: { params: { scope: string } } } }
    ).options;
    expect(options.authorization.params.scope).toBe('openid email profile');
  });
});

describe('readCookie', () => {
  it('finds the session cookie among others', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE_NAME}=tok%3Den; b=2`, SESSION_COOKIE_NAME)).toBe(
      'tok=en',
    );
  });

  it('does not match on a name suffix', () => {
    expect(readCookie(`x${SESSION_COOKIE_NAME}=evil`, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('handles absent, empty and malformed values', () => {
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE_NAME}=`, SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE_NAME}=%E0%A4%A`, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('uses a non-__Host- name outside production', () => {
    expect(SESSION_COOKIE_NAME).toBe('ysa.session');
  });
});

describe('redirect paths', () => {
  it('prefixes the locale and falls back for unreleased ones', () => {
    expect(localePath('en', '/channels')).toBe('/en/channels');
    expect(localePath('km', 'channels')).toBe('/en/channels');
    expect(localePath(undefined, '/x')).toBe('/en/x');
  });

  it('splits CONFLICT by cause so the user knows what to do', () => {
    expect(flashCodeFor({ code: 'CONFLICT', messageKey: 'errors.channels.limitReached' })).toBe(
      'CHANNEL_LIMIT',
    );
    expect(
      flashCodeFor({ code: 'CONFLICT', messageKey: 'errors.channels.ownedByAnotherUser' }),
    ).toBe('CHANNEL_OWNED');
    expect(flashCodeFor({ code: 'OAUTH_DENIED', messageKey: 'errors.oauth.denied' })).toBe(
      'OAUTH_DENIED',
    );
  });

  it('sends signed-out users to sign-in', () => {
    const error = { code: 'UNAUTHENTICATED', messageKey: 'errors.unauthenticated' };
    expect(errorRedirectPath('en', error, true)).toBe('/en/sign-in');
    expect(errorRedirectPath('en', { code: 'OAUTH_FAILED', messageKey: 'x' }, false)).toBe(
      '/en/sign-in',
    );
    expect(errorRedirectPath('en', { code: 'OAUTH_FAILED', messageKey: 'x' }, true)).toBe(
      '/en/channels?error=OAUTH_FAILED',
    );
  });
});
