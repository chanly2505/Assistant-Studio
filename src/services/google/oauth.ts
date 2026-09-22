import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '@/domain/errors/app-error';
import { SecretString } from '@/domain/shared/secret';
import { CHANNEL_CONNECT_SCOPES, parseScopes } from '@/domain/youtube/scopes';
import { config, env } from '@/lib/env';

import { describeShape, errorReason, googleRequest } from './http';

/**
 * Google OAuth for the CHANNEL-CONNECT grant (Grant B).
 * Sign-in (Grant A) is handled by Auth.js and never touches this module.
 * docs/architecture/05-authentication-architecture.md §5.3–5.4
 */

export const GOOGLE_AUTHORIZE_URL = config.external.googleAuthorize;
export const GOOGLE_TOKEN_URL = config.external.googleToken;
export const GOOGLE_REVOKE_URL = config.external.googleRevoke;
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

function credentials(): { clientId: string; clientSecret: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new AppError('CONFIGURATION_MISSING', {
      detail: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set',
      params: { setting: 'GOOGLE_CLIENT_ID' },
    });
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

/* --------------------------------- PKCE --------------------------------- */

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636, S256. 32 random bytes → a 43-character verifier. */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/* ---------------------------- authorization URL ---------------------------- */

export function buildAuthorizationUrl(params: {
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const { clientId } = credentials();
  const url = new URL(GOOGLE_AUTHORIZE_URL);

  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: config.youtubeOAuthRedirectUri,
    response_type: 'code',
    scope: CHANNEL_CONNECT_SCOPES.join(' '),
    // offline + consent is what makes Google return a refresh token every time,
    // including when the user has granted this app before.
    access_type: 'offline',
    // select_account shows the account chooser, which is where a user picks a
    // brand account. Each brand channel has its own Google identity (`sub`), so
    // it becomes its own YouTubeConnection.
    prompt: 'consent select_account',
    // Deliberately NOT include_granted_scopes: merging the sign-in scopes into
    // this token would make "disconnect channel" revoke sign-in consent too.
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  }).toString();

  return url.toString();
}

/* ------------------------------ token exchange ----------------------------- */

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string(),
  id_token: z.string().optional(),
});

const IdTokenClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  exp: z.number(),
});

export type GoogleIdentity = { sub: string; email: string };

export interface ExchangedTokens {
  accessToken: SecretString;
  refreshToken: SecretString | null;
  expiresInSeconds: number;
  scopes: string[];
  identity: GoogleIdentity;
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  log?: Logger;
}): Promise<ExchangedTokens> {
  const { clientId, clientSecret } = credentials();

  const response = await googleRequest({
    api: 'google_oauth',
    operation: 'token.exchange',
    url: GOOGLE_TOKEN_URL,
    ...(params.log ? { log: params.log } : {}),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        code_verifier: params.codeVerifier,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: config.youtubeOAuthRedirectUri,
      }),
    },
  });

  if (!response.ok) {
    // invalid_grant here means the code expired, was already used, or the
    // verifier did not match — all "start again", none a server fault.
    throw new AppError('OAUTH_FAILED', {
      detail: `token exchange failed: ${errorReason(response.body) ?? response.status}`,
    });
  }

  const parsed = TokenResponse.safeParse(response.body);
  if (!parsed.success) {
    throw new AppError('OAUTH_FAILED', {
      detail: `token exchange returned an unexpected shape ${describeShape(response.body)}`,
    });
  }

  const tokens = parsed.data;
  if (!tokens.id_token) {
    throw new AppError('OAUTH_FAILED', { detail: 'token response carried no id_token' });
  }

  return {
    accessToken: new SecretString(tokens.access_token, 'accessToken'),
    refreshToken: tokens.refresh_token
      ? new SecretString(tokens.refresh_token, 'refreshToken')
      : null,
    expiresInSeconds: tokens.expires_in,
    scopes: parseScopes(tokens.scope),
    identity: readIdToken(tokens.id_token, clientId),
  };
}

/**
 * Reads the id_token's claims WITHOUT verifying its signature.
 *
 * This is safe only because of where it came from: directly from Google's token
 * endpoint over a TLS back-channel this server initiated. OpenID Connect Core
 * §3.1.3.7 (6) permits TLS server validation in place of signature checking for
 * exactly this case. `iss` and `aud` are still enforced — an id_token minted for
 * another client must never be accepted. Never use this on a token that arrived
 * any other way (a browser, a query string, a header).
 */
export function readIdToken(idToken: string, expectedAudience: string): GoogleIdentity {
  const payload = idToken.split('.')[1];
  if (!payload) throw new AppError('OAUTH_FAILED', { detail: 'id_token is malformed' });

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new AppError('OAUTH_FAILED', { detail: 'id_token payload is not JSON', cause });
  }

  const parsed = IdTokenClaims.safeParse(claims);
  if (!parsed.success) {
    throw new AppError('OAUTH_FAILED', { detail: 'id_token claims are incomplete' });
  }
  if (!GOOGLE_ISSUERS.includes(parsed.data.iss)) {
    throw new AppError('OAUTH_FAILED', { detail: `id_token issuer ${parsed.data.iss} rejected` });
  }
  if (parsed.data.aud !== expectedAudience) {
    throw new AppError('OAUTH_FAILED', { detail: 'id_token audience does not match this client' });
  }

  return { sub: parsed.data.sub, email: parsed.data.email.toLowerCase() };
}

/* ---------------------------------- refresh --------------------------------- */

export interface RefreshedToken {
  accessToken: SecretString;
  expiresInSeconds: number;
  scopes: string[];
}

export async function refreshAccessToken(
  refreshToken: SecretString,
  log?: Logger,
): Promise<RefreshedToken> {
  const { clientId, clientSecret } = credentials();

  const response = await googleRequest({
    api: 'google_oauth',
    operation: 'token.refresh',
    url: GOOGLE_TOKEN_URL,
    ...(log ? { log } : {}),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken.expose(),
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  });

  if (!response.ok) {
    const reason = errorReason(response.body);
    // Revoked by the user, expired (7 days in Testing mode — docs §12A), or the
    // password changed. Expected product state: reconnect, not retry.
    if (response.status === 400 && reason === 'invalid_grant') {
      throw new AppError('YOUTUBE_REAUTH_REQUIRED', { detail: 'refresh token rejected' });
    }
    if (response.status >= 500 || response.status === 429) {
      throw new AppError('UPSTREAM_UNAVAILABLE', {
        detail: `token refresh ${response.status}`,
        ...(response.retryAfterSeconds ? { retryAfterSeconds: response.retryAfterSeconds } : {}),
      });
    }
    // invalid_client / unauthorized_client: our credentials are wrong. A defect.
    throw new AppError('OAUTH_FAILED', {
      detail: `token refresh failed: ${reason ?? response.status}`,
    });
  }

  const parsed = TokenResponse.safeParse(response.body);
  if (!parsed.success) {
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `token refresh returned an unexpected shape ${describeShape(response.body)}`,
    });
  }

  return {
    accessToken: new SecretString(parsed.data.access_token, 'accessToken'),
    expiresInSeconds: parsed.data.expires_in,
    scopes: parseScopes(parsed.data.scope),
  };
}

/* ---------------------------------- revoke --------------------------------- */

export type RevokeOutcome = 'revoked' | 'already_invalid';

/**
 * Revoking the refresh token revokes the whole grant, including every access
 * token issued from it. Google answers 400 invalid_token for a token that is
 * already dead — which is the outcome the user asked for, so it is not an error.
 */
export async function revokeToken(token: SecretString, log?: Logger): Promise<RevokeOutcome> {
  const response = await googleRequest({
    api: 'google_oauth',
    operation: 'token.revoke',
    url: GOOGLE_REVOKE_URL,
    ...(log ? { log } : {}),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.expose() }),
    },
  });

  if (response.ok) return 'revoked';
  if (response.status === 400 && errorReason(response.body) === 'invalid_token') {
    return 'already_invalid';
  }

  throw new AppError('UPSTREAM_UNAVAILABLE', {
    detail: `token revocation failed: ${errorReason(response.body) ?? response.status}`,
  });
}
