import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE_NAME } from './cookies';
import { getSessionFromToken, type SessionUser } from './session';

/** The signed-in user for a server component or server action, or null. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const session = await getSessionFromToken(store.get(SESSION_COOKIE_NAME)?.value);
  return session?.user ?? null;
}

/**
 * For authenticated layouts and server actions. Verification happens here, on
 * the server with database access — never in middleware, which runs on the edge
 * and could only check that a cookie exists.
 */
export async function requireUser(locale: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/${locale}/sign-in`);
  return user;
}
