import { createHash } from 'node:crypto';

import { sessionRepository } from '@/db/repositories/session.repository';

import { SESSION_COOKIE_NAME, readCookie } from './cookies';

/**
 * Session resolution, behind an interface.
 *
 * Auth.js owns sign-in and sign-out: the Google handshake, id_token signature
 * checks, state/nonce/PKCE, and writing the Session row plus its cookie.
 * Reading a session is done here, directly against that row, because:
 *   - the lookup is one indexed query, fully testable against a real database;
 *   - suspending a user takes effect on their next request;
 *   - route handlers and server components use the exact same code path.
 *
 * Sessions have a fixed 30-day lifetime and are not extended on use. Extending
 * the row without re-issuing the cookie would do nothing, and a fixed lifetime
 * bounds how long a stolen cookie is useful.
 */

export interface SessionUser {
  id: string;
  email: string;
  locale: string;
  planKey: string;
}

export interface Session {
  user: SessionUser;
  expires: Date;
}

export interface SessionProvider {
  /** `token` is the session cookie's value, or null when there is no cookie. */
  resolve(token: string | null): Promise<Session | null>;
}

export class DatabaseSessionProvider implements SessionProvider {
  async resolve(token: string | null): Promise<Session | null> {
    if (!token) return null;
    return sessionRepository.findActive(token);
  }
}

/** Test double. Not exported from any production entry point. */
export class StaticSessionProvider implements SessionProvider {
  constructor(private readonly session: Session | null) {}

  async resolve(): Promise<Session | null> {
    return this.session;
  }
}

/** Kept for tests that need to assert "nobody is signed in". */
export class NullSessionProvider implements SessionProvider {
  async resolve(): Promise<Session | null> {
    return null;
  }
}

let provider: SessionProvider = new DatabaseSessionProvider();

export function getSessionProvider(): SessionProvider {
  return provider;
}

export function setSessionProvider(next: SessionProvider): void {
  provider = next;
}

/** Resolves the session from a request's cookie header. */
export async function getSession(request: Request): Promise<Session | null> {
  return provider.resolve(readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME));
}

/** For server components, which read cookies through `next/headers`. */
export async function getSessionFromToken(
  token: string | null | undefined,
): Promise<Session | null> {
  return provider.resolve(token ?? null);
}

/**
 * Salted hash of a client IP for audit logs. Raw addresses are never stored.
 * docs/architecture/08-security-architecture.md §8.6
 */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/**
 * Best-effort client address for rate limiting. Behind a proxy this is only as
 * trustworthy as the proxy, so it is used for throttling and hashed audit
 * entries — never for authorization.
 */
export function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return `ip:${ip}`;
}
