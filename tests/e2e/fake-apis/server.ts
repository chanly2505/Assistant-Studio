/**
 * A local stand-in for every external service the app calls, for the
 * end-to-end suite. docs/architecture/09 §9.4: "Google's real consent screen
 * cannot and should not be automated."
 *
 *   Google sign-in (OIDC)   /.well-known/openid-configuration, /certs,
 *                           /o/oauth2/v2/auth, /oidc/token, /userinfo
 *   Google OAuth (connect)  /o/oauth2/v2/auth, /token, /revoke
 *   YouTube Data v3         /youtube/v3/{channels,playlistItems,videos}
 *   YouTube Analytics v2    /v2/reports
 *   OpenAI Responses        /v1/responses
 *   test control            /__state, /__reset
 *
 * The app reaches it through FAKE_EXTERNAL_APIS_URL (src/lib/env.ts), which is
 * refused unless everything is on localhost. Consent is automatic: the
 * authorize endpoint redirects straight back with a code, exactly as Google
 * does after a user clicks "Allow". Sign-in id_tokens are really signed
 * (RS256, published at /certs), because Auth.js verifies them.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { FAKE_CHANNEL, FAKE_IDENTITY, FAKE_TITLES, FAKE_VIDEOS } from './data';

const PORT = Number(process.env.FAKE_APIS_PORT ?? 3199);
const BASE = `http://localhost:${PORT}`;

/* ------------------------------- signing key ------------------------------- */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fake-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signJwt(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64(claims);
  const signature = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(privateKey)
    .toString('base64url');
  return `${head}.${body}.${signature}`;
}

/* ---------------------------------- state ---------------------------------- */

interface Grant {
  clientId: string;
  redirectUri: string;
  scope: string;
  nonce: string | null;
  codeChallenge: string | null;
}
const codes = new Map<string, Grant>();
const counters = { signIns: 0, connects: 0, refreshes: 0, revocations: 0, aiCalls: 0 };

function reset() {
  codes.clear();
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
}

/* ---------------------------------- helpers --------------------------------- */

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function clientIdFrom(req: IncomingMessage, form: URLSearchParams): string {
  const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
  if (basic)
    return decodeURIComponent(Buffer.from(basic, 'base64').toString('utf8').split(':')[0] ?? '');
  return form.get('client_id') ?? '';
}

function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------- routes ---------------------------------- */

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname;

  /* ---- control ---- */
  if (path === '/__state') return send(res, 200, counters);
  if (path === '/__reset') {
    reset();
    return send(res, 200, { ok: true });
  }

  /* ---- OIDC discovery (sign-in) ---- */
  if (path === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: BASE,
      authorization_endpoint: `${BASE}/o/oauth2/v2/auth`,
      token_endpoint: `${BASE}/oidc/token`,
      userinfo_endpoint: `${BASE}/userinfo`,
      jwks_uri: `${BASE}/certs`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'email', 'email_verified', 'name', 'iss', 'aud'],
    });
  }
  if (path === '/certs') return send(res, 200, { keys: [jwk] });

  /* ---- authorize: automatic consent ---- */
  if (path === '/o/oauth2/v2/auth') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      clientId: url.searchParams.get('client_id') ?? '',
      redirectUri,
      scope: url.searchParams.get('scope') ?? '',
      nonce: url.searchParams.get('nonce'),
      codeChallenge: url.searchParams.get('code_challenge'),
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    const state = url.searchParams.get('state');
    if (state) back.searchParams.set('state', state);
    // The sign-in flow is OIDC and expects the issuer echoed back.
    if (redirectUri.includes('/api/auth/callback/')) back.searchParams.set('iss', BASE);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  /* ---- token endpoints ---- */
  if ((path === '/oidc/token' || path === '/token') && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const clientId = clientIdFrom(req, form);
    const now = Math.floor(Date.now() / 1000);

    if (form.get('grant_type') === 'refresh_token') {
      counters.refreshes += 1;
      return send(res, 200, {
        access_token: `ya29.fake-${randomBytes(6).toString('hex')}`,
        expires_in: 3599,
        token_type: 'Bearer',
        scope:
          'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
      });
    }

    const grant = codes.get(form.get('code') ?? '');
    if (!grant) return send(res, 400, { error: 'invalid_grant' });
    codes.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier');
    if (grant.codeChallenge) {
      const expected = createHash('sha256')
        .update(verifier ?? '')
        .digest('base64url');
      if (expected !== grant.codeChallenge)
        return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
    }

    if (path === '/oidc/token') {
      counters.signIns += 1;
      return send(res, 200, {
        access_token: `ya29.fake-login-${randomBytes(6).toString('hex')}`,
        token_type: 'Bearer',
        expires_in: 3599,
        scope: grant.scope,
        id_token: signJwt({
          iss: BASE,
          aud: clientId,
          sub: FAKE_IDENTITY.sub,
          email: FAKE_IDENTITY.email,
          email_verified: true,
          name: FAKE_IDENTITY.name,
          iat: now,
          exp: now + 3600,
          ...(grant.nonce ? { nonce: grant.nonce } : {}),
        }),
      });
    }

    counters.connects += 1;
    return send(res, 200, {
      access_token: `ya29.fake-${randomBytes(6).toString('hex')}`,
      refresh_token: `1//fake-refresh-${randomBytes(6).toString('hex')}`,
      expires_in: 3599,
      token_type: 'Bearer',
      scope: grant.scope.replace(/\bemail\b/, 'https://www.googleapis.com/auth/userinfo.email'),
      // The connect flow reads (not verifies) this back-channel token, as Google allows.
      id_token: signJwt({
        iss: 'https://accounts.google.com',
        aud: clientId,
        sub: FAKE_IDENTITY.sub,
        email: FAKE_IDENTITY.email,
        email_verified: true,
        iat: now,
        exp: now + 3600,
      }),
    });
  }
  if (path === '/revoke' && req.method === 'POST') {
    counters.revocations += 1;
    return send(res, 200, {});
  }
  if (path === '/userinfo') {
    return send(res, 200, {
      sub: FAKE_IDENTITY.sub,
      email: FAKE_IDENTITY.email,
      email_verified: true,
      name: FAKE_IDENTITY.name,
    });
  }

  /* ---- YouTube Data API ---- */
  if (path === '/youtube/v3/channels') {
    return send(res, 200, {
      items: [
        {
          id: FAKE_CHANNEL.id,
          snippet: {
            title: FAKE_CHANNEL.title,
            description: 'Breakfast in Phnom Penh',
            customUrl: '@journeykitchen',
            publishedAt: '2021-01-01T00:00:00Z',
            country: 'KH',
            thumbnails: { medium: { url: 'https://yt3.ggpht.com/fake-avatar.jpg' } },
          },
          contentDetails: { relatedPlaylists: { uploads: `UU${FAKE_CHANNEL.id.slice(2)}` } },
          statistics: {
            viewCount: '48200',
            subscriberCount: '1230',
            hiddenSubscriberCount: false,
            videoCount: String(FAKE_VIDEOS.length),
          },
        },
      ],
    });
  }
  if (path === '/youtube/v3/playlistItems') {
    return send(res, 200, {
      pageInfo: { totalResults: FAKE_VIDEOS.length },
      items: FAKE_VIDEOS.map((v) => ({ contentDetails: { videoId: v.id } })),
    });
  }
  if (path === '/youtube/v3/videos') {
    const ids = (url.searchParams.get('id') ?? '').split(',');
    return send(res, 200, {
      items: FAKE_VIDEOS.filter((v) => ids.includes(v.id)).map((v, i) => ({
        id: v.id,
        snippet: {
          title: v.title,
          publishedAt: `${isoDay(-(10 + i * 7))}T10:00:00Z`,
          thumbnails: { medium: { url: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` } },
        },
        contentDetails: { duration: 'PT8M30S' },
        status: { privacyStatus: 'public' },
        statistics: {
          viewCount: String(1000 * (i + 1)),
          likeCount: String(40 * (i + 1)),
          commentCount: String(5 + i),
        },
      })),
    });
  }

  /* ---- YouTube Analytics ---- */
  if (path === '/v2/reports') {
    const start = url.searchParams.get('startDate') ?? isoDay(-30);
    const end = url.searchParams.get('endDate') ?? isoDay(-3);
    const metrics = (url.searchParams.get('metrics') ?? '').split(',');
    const columns = ['day', ...metrics];
    const rows: Array<Array<string | number>> = [];
    for (
      let d = new Date(`${start}T00:00:00Z`);
      d <= new Date(`${end}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const day = d.toISOString().slice(0, 10);
      const seed = d.getUTCDate();
      rows.push(
        columns.map((c) =>
          c === 'day'
            ? day
            : c === 'views'
              ? 200 + seed * 3
              : c === 'estimatedMinutesWatched'
                ? 900 + seed * 10
                : c === 'averageViewDuration'
                  ? 240
                  : c === 'averageViewPercentage'
                    ? 41.5
                    : c === 'subscribersGained'
                      ? 4
                      : c === 'subscribersLost'
                        ? 1
                        : 0,
        ),
      );
    }
    return send(res, 200, {
      kind: 'youtubeAnalytics#resultTable',
      columnHeaders: columns.map((name) => ({
        name,
        columnType: name === 'day' ? 'DIMENSION' : 'METRIC',
        dataType: name === 'day' ? 'STRING' : 'INTEGER',
      })),
      ...(rows.length ? { rows } : {}),
    });
  }

  /* ---- OpenAI Responses ---- */
  if (path === '/v1/responses' && req.method === 'POST') {
    counters.aiCalls += 1;
    const body = JSON.parse(await readBody(req)) as { text?: { format?: { name?: string } } };
    const outputs: Record<string, unknown> = {
      video_titles: {
        titles: FAKE_TITLES.map((text, i) => ({
          text,
          style: 'direct',
          reasoning: 'Specific and clear.',
          estimatedStrength: 3 + (i % 2),
        })),
      },
      content_ideas: {
        ideas: [1, 2, 3].map((n) => ({
          title: `Morning market idea ${n}`,
          angle: 'Follow one vendor from setup to the rush.',
          hook: 'Most visitors never see this.',
          format: 'vlog',
          keywords: ['street food', 'phnom penh'],
          rationale: 'Suits a local-food channel.',
        })),
      },
    };
    const value = outputs[body.text?.format?.name ?? ''];
    if (!value) return send(res, 400, { error: { message: 'fake has no output for this schema' } });
    return send(res, 200, {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(value) }],
        },
      ],
      usage: {
        input_tokens: 900,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 400,
        total_tokens: 1300,
      },
    });
  }

  send(res, 404, { error: `fake has no route for ${req.method} ${path}` });
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => send(res, 500, { error: String(error) }));
}).listen(PORT, () => console.log(`fake external APIs listening on ${BASE}`));
