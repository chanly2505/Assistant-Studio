import 'server-only';

import { PrismaAdapter } from '@auth/prisma-adapter';
import NextAuth, { type NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

import { prisma } from '@/db/prisma';
import { auditRepository } from '@/db/repositories/audit.repository';
import { userRepository } from '@/db/repositories/user.repository';
import { LOGIN_SCOPES } from '@/domain/youtube/scopes';
import { config, env } from '@/lib/env';
import { logger } from '@/lib/logger';

import { hardenAdapter } from './adapter';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from './cookies';

/**
 * Sign-in: Grant A. Identity scopes ONLY.
 * docs/architecture/05-authentication-architecture.md §5.1–5.2
 *
 * YouTube access is never requested here. It is a separate grant the user opts
 * into from the Channels page (src/modules/youtube/*), stored encrypted in
 * YouTubeConnection. A unit test asserts the provider's scope string.
 */

export const isGoogleSignInConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET,
);

export const googleProvider = Google({
  clientId: env.GOOGLE_CLIENT_ID ?? 'not-configured',
  clientSecret: env.GOOGLE_CLIENT_SECRET ?? 'not-configured',
  // End-to-end tests only: sign-in goes to the local fake OIDC provider,
  // which Auth.js discovers from this issuer. Unset everywhere else.
  ...(config.external.googleSignInIssuer ? { issuer: config.external.googleSignInIssuer } : {}),
  authorization: {
    params: {
      scope: LOGIN_SCOPES.join(' '),
      prompt: 'select_account',
    },
  },
});

export const authConfig: NextAuthConfig = {
  adapter: hardenAdapter(PrismaAdapter(prisma)),
  providers: isGoogleSignInConfigured ? [googleProvider] : [],
  secret: env.AUTH_SECRET,
  // AUTH_URL is pinned to APP_URL in src/lib/env.ts, so callback URLs come from
  // configuration, not from the request's Host header.
  trustHost: true,

  session: {
    strategy: 'database',
    maxAge: SESSION_MAX_AGE_SECONDS,
    // Never extended on use — see src/lib/auth/session.ts.
    updateAge: SESSION_MAX_AGE_SECONDS,
  },

  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: config.isProduction,
      },
    },
  },

  pages: {
    signIn: '/en/sign-in',
    error: '/en/sign-in',
  },

  callbacks: {
    /**
     * Google says whether it verified the address. An unverified email must not
     * become an identity: whoever first claims an address would own the account.
     */
    signIn({ account, profile }) {
      if (account?.provider !== 'google') return false;
      return profile?.email_verified === true;
    },
  },

  events: {
    async createUser({ user }) {
      if (!user.id) return;
      await userRepository.ensureSettings(user.id);
      await auditRepository.record({ userId: user.id, action: 'auth.user_created' });
    },
    async signIn({ user, isNewUser }) {
      if (!user.id) return;
      await auditRepository.record({
        userId: user.id,
        action: 'auth.sign_in',
        metadata: { provider: 'google', isNewUser: Boolean(isNewUser) },
      });
    },
    async signOut(message) {
      const userId = 'session' in message ? message.session?.userId : undefined;
      if (!userId) return;
      await auditRepository.record({ userId, action: 'auth.sign_out' });
    },
  },

  logger: {
    error(error) {
      logger.error({ err: { name: error.name, message: error.message } }, 'auth.js error');
    },
    warn(warning) {
      // Not `code`: that key is redacted (OAuth codes are credentials).
      logger.warn({ authWarning: warning }, 'auth.js warning');
    },
  },
};

export const { handlers, signIn, signOut } = NextAuth(authConfig);
