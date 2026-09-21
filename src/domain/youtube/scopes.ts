/**
 * OAuth scopes, and the rule that keeps the two grants apart.
 * docs/architecture/05-authentication-architecture.md §5.1
 *
 * Sign-in asks for identity ONLY. YouTube access is a second, separate grant
 * the user opts into from the Channels page. A unit test asserts the login
 * scope list contains no YouTube scope — asking for analytics on the sign-up
 * screen is both a conversion killer and a bigger blast radius on revoke.
 */

export const LOGIN_SCOPES = ['openid', 'email', 'profile'] as const;

export const YOUTUBE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_ANALYTICS_READONLY = 'https://www.googleapis.com/auth/yt-analytics.readonly';

/** Every one must be granted, or nothing is stored. */
export const REQUIRED_YOUTUBE_SCOPES = [YOUTUBE_READONLY, YOUTUBE_ANALYTICS_READONLY] as const;

/**
 * `openid email` rides along so the token response carries an id_token naming
 * the Google account. That identifies the grant; it is not a login.
 */
export const CHANNEL_CONNECT_SCOPES = ['openid', 'email', ...REQUIRED_YOUTUBE_SCOPES] as const;

/** Google returns granted scopes as one space-separated string. */
export function parseScopes(scope: string | undefined | null): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Google's consent screen lets a user untick individual scopes ("granular
 * consent"), so a successful exchange does NOT imply every scope was granted.
 */
export function missingScopes(granted: readonly string[]): string[] {
  return REQUIRED_YOUTUBE_SCOPES.filter((scope) => !granted.includes(scope));
}
