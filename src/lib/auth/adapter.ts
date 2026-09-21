import type { Adapter, AdapterAccount, AdapterUser } from 'next-auth/adapters';

/**
 * Wraps the stock Prisma adapter with three changes.
 *
 * 1. Login tokens are never stored. The stock adapter writes Google's
 *    access_token, refresh_token and id_token into `Account` in plaintext. This
 *    app never uses them after sign-in (sessions are database rows; YouTube
 *    access is a separate, encrypted grant), so the safest copy is the one that
 *    was never written.
 * 2. Emails are lowercased on the way in and on lookup, so `Alice@x.com` and
 *    `alice@x.com` cannot become two accounts. (There is no citext column.)
 * 3. Nothing else changes — every other method is the stock implementation.
 */
export function hardenAdapter(base: Adapter): Adapter {
  const required = <K extends keyof Adapter>(key: K): NonNullable<Adapter[K]> => {
    const method = base[key];
    if (!method) throw new Error(`hardenAdapter: base adapter lacks ${String(key)}`);
    return method as NonNullable<Adapter[K]>;
  };

  const createUser = required('createUser');
  const getUserByEmail = required('getUserByEmail');
  const linkAccount = required('linkAccount');

  return {
    ...base,

    createUser(user: AdapterUser) {
      return createUser({ ...user, email: user.email.toLowerCase() });
    },

    getUserByEmail(email: string) {
      return getUserByEmail(email.toLowerCase());
    },

    linkAccount(account: AdapterAccount) {
      return linkAccount(stripTokens(account));
    },
  };
}

export function stripTokens(account: AdapterAccount): AdapterAccount {
  const {
    access_token: _accessToken,
    refresh_token: _refreshToken,
    id_token: _idToken,
    expires_at: _expiresAt,
    session_state: _sessionState,
    ...kept
  } = account;
  return kept as AdapterAccount;
}
