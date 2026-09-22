import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { YOUTUBE_ANALYTICS_READONLY, YOUTUBE_READONLY } from '@/domain/youtube/scopes';

/**
 * A fake Google for tests, at the network layer.
 *
 * The real code paths run unchanged — real `fetch`, real URLs, real response
 * parsing — and MSW answers instead of Google. `onUnhandledRequest: 'error'`
 * means a test that would reach the real internet fails instead.
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const FULL_SCOPE = `openid https://www.googleapis.com/auth/userinfo.email ${YOUTUBE_READONLY} ${YOUTUBE_ANALYTICS_READONLY}`;

export const googleServer = setupServer();

/** Every request the fake received, for assertions like "exactly one refresh". */
export const received: Array<{
  url: string;
  query: URLSearchParams;
  body: URLSearchParams | null;
  authorization: string | null;
}> = [];

googleServer.events.on('request:start', async ({ request }) => {
  const clone = request.clone();
  const text = request.method === 'POST' ? await clone.text() : '';
  received.push({
    url: request.url.split('?')[0] ?? request.url,
    query: new URL(request.url).searchParams,
    body: text ? new URLSearchParams(text) : null,
    authorization: request.headers.get('authorization'),
  });
});

export function resetGoogle(): void {
  googleServer.resetHandlers();
  received.length = 0;
}

export function callsTo(url: string) {
  return received.filter((call) => call.url === url);
}

/** An unsigned id_token. The app reads it only from the TLS back-channel. */
export function idToken(claims: Partial<Record<string, unknown>> = {}): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: 'google-sub-1',
      email: 'Creator@Example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
    'signature-not-checked',
  ].join('.');
}

export function channelItem(
  overrides: Partial<{ id: string; title: string; hidden: boolean }> = {},
) {
  const id = overrides.id ?? 'UC_test_channel_1';
  return {
    id,
    snippet: {
      title: overrides.title ?? 'Phnom Penh Street Food',
      description: 'Food and travel',
      customUrl: '@ppstreetfood',
      publishedAt: '2019-04-01T10:00:00Z',
      country: 'KH',
      thumbnails: { medium: { url: 'https://yt3.ggpht.com/avatar-medium.jpg' } },
    },
    contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } },
    statistics: overrides.hidden
      ? { viewCount: '1234567', hiddenSubscriberCount: true, videoCount: '88' }
      : {
          viewCount: '1234567',
          subscriberCount: '12300',
          hiddenSubscriberCount: false,
          videoCount: '88',
        },
  };
}

/* ------------------------------- handlers ------------------------------- */

export const google = {
  tokenExchange(
    options: {
      scope?: string;
      refreshToken?: string | null;
      sub?: string;
      email?: string;
      aud?: string;
      status?: number;
      error?: string;
    } = {},
  ) {
    return http.post(TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') !== 'authorization_code') return undefined;

      if (options.status) {
        return HttpResponse.json(
          { error: options.error ?? 'invalid_grant' },
          { status: options.status },
        );
      }
      return HttpResponse.json({
        access_token: 'ya29.exchanged-access-token',
        expires_in: 3599,
        ...(options.refreshToken === null
          ? {}
          : { refresh_token: options.refreshToken ?? '1//refresh-token-A' }),
        scope: options.scope ?? FULL_SCOPE,
        token_type: 'Bearer',
        id_token: idToken({
          sub: options.sub ?? 'google-sub-1',
          email: options.email ?? 'Creator@Example.com',
          ...(options.aud ? { aud: options.aud } : {}),
        }),
      });
    });
  },

  tokenRefresh(options: { status?: number; error?: string; delayMs?: number } = {}) {
    return http.post(TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') !== 'refresh_token') return undefined;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));

      if (options.status) {
        return HttpResponse.json(
          { error: options.error ?? 'server_error' },
          { status: options.status },
        );
      }
      return HttpResponse.json({
        access_token: `ya29.refreshed-${Date.now()}`,
        expires_in: 3599,
        scope: `${YOUTUBE_READONLY} ${YOUTUBE_ANALYTICS_READONLY}`,
        token_type: 'Bearer',
      });
    });
  },

  channels(items: unknown[] | undefined) {
    return http.get(CHANNELS_URL, () =>
      HttpResponse.json({ kind: 'youtube#channelListResponse', ...(items ? { items } : {}) }),
    );
  },

  channelsError(status: number, reason: string) {
    return http.get(CHANNELS_URL, () =>
      HttpResponse.json({ error: { code: status, errors: [{ reason }] } }, { status }),
    );
  },

  revoke(outcome: 'ok' | 'invalid_token' | 'network_error' = 'ok') {
    return http.post(REVOKE_URL, () => {
      if (outcome === 'network_error') return HttpResponse.error();
      if (outcome === 'invalid_token') {
        return HttpResponse.json({ error: 'invalid_token' }, { status: 400 });
      }
      return new HttpResponse(null, { status: 200 });
    });
  },
};

/* ------------------------------ YouTube catalog ------------------------------ */

export const PLAYLIST_URL = 'https://www.googleapis.com/youtube/v3/playlistItems';
export const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

export interface FakeVideo {
  id: string;
  snippet: { title: string; publishedAt: string; description?: string; thumbnails?: object };
  contentDetails: { duration: string };
  status: { privacyStatus: 'public' | 'unlisted' | 'private' };
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export function videoItem(
  id: string,
  options: {
    title?: string;
    publishedAt?: string;
    duration?: string;
    privacy?: 'public' | 'unlisted' | 'private';
    views?: number;
    likes?: number | null;
    comments?: number | null;
  } = {},
): FakeVideo {
  return {
    id,
    snippet: {
      title: options.title ?? `Video ${id}`,
      publishedAt: options.publishedAt ?? '2026-09-01T10:00:00Z',
      thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } },
    },
    contentDetails: { duration: options.duration ?? 'PT8M30S' },
    status: { privacyStatus: options.privacy ?? 'public' },
    statistics: {
      viewCount: String(options.views ?? 100),
      ...(options.likes === null ? {} : { likeCount: String(options.likes ?? 10) }),
      ...(options.comments === null ? {} : { commentCount: String(options.comments ?? 2) }),
    },
  };
}

/**
 * A channel's uploads as YouTube would serve them: `playlist` is the uploads
 * order (newest first), paged; `videos` answers by id. An id in the playlist
 * but absent from `catalog` behaves like a deleted video.
 */
export function youtubeCatalog(
  playlist: string[],
  catalog: FakeVideo[],
  options: { pageSize?: number } = {},
) {
  const pageSize = options.pageSize ?? 50;
  const byId = new Map(catalog.map((video) => [video.id, video]));

  return [
    http.get(PLAYLIST_URL, ({ request }) => {
      const url = new URL(request.url);
      const start = Number(url.searchParams.get('pageToken') ?? '0');
      const slice = playlist.slice(start, start + pageSize);
      const next = start + pageSize < playlist.length ? String(start + pageSize) : undefined;
      return HttpResponse.json({
        pageInfo: { totalResults: playlist.length },
        ...(next ? { nextPageToken: next } : {}),
        items: slice.map((videoId) => ({ contentDetails: { videoId } })),
      });
    }),
    http.get(VIDEOS_URL, ({ request }) => {
      const ids = (new URL(request.url).searchParams.get('id') ?? '').split(',').filter(Boolean);
      return HttpResponse.json({
        items: ids.map((id) => byId.get(id)).filter(Boolean),
      });
    }),
  ];
}

export function playlistNotFound() {
  return http.get(PLAYLIST_URL, () =>
    HttpResponse.json(
      { error: { code: 404, errors: [{ reason: 'playlistNotFound' }] } },
      { status: 404 },
    ),
  );
}

/* ------------------------------ YouTube Analytics ------------------------------ */

export const ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

export interface FakeDay {
  day: string;
  views?: number;
  minutes?: number;
  gained?: number;
  lost?: number;
}

/**
 * Answers reports.query like YouTube: a result table whose columns follow the
 * requested dimensions + metrics, rows only for days that have data (days in
 * `days` outside the requested window are dropped). `byVideo` supplies a
 * video's series when the request filters video==ID.
 */
export function youtubeAnalytics(
  channelDays: FakeDay[],
  options: { byVideo?: Record<string, FakeDay[]>; reverseColumns?: boolean } = {},
) {
  return http.get(ANALYTICS_URL, ({ request }) => {
    const query = new URL(request.url).searchParams;
    const start = query.get('startDate') ?? '';
    const end = query.get('endDate') ?? '';
    const filter = query.get('filters') ?? '';
    const videoId = filter.startsWith('video==') ? filter.slice('video=='.length) : null;
    const source = videoId ? (options.byVideo?.[videoId] ?? []) : channelDays;

    let columns = ['day', ...(query.get('metrics') ?? '').split(',')];
    if (options.reverseColumns) columns = [...columns].reverse();

    const valueOf = (d: FakeDay, column: string): string | number => {
      switch (column) {
        case 'day':
          return d.day;
        case 'views':
          return d.views ?? 0;
        case 'estimatedMinutesWatched':
          return d.minutes ?? 0;
        case 'averageViewDuration':
          return d.views ? Math.round(((d.minutes ?? 0) * 60) / d.views) : 0;
        case 'averageViewPercentage':
          return 42.5;
        case 'subscribersGained':
          return d.gained ?? 0;
        case 'subscribersLost':
          return d.lost ?? 0;
        default:
          return 0;
      }
    };

    const rows = source
      .filter((d) => d.day >= start && d.day <= end)
      .map((d) => columns.map((column) => valueOf(d, column)));

    return HttpResponse.json({
      kind: 'youtubeAnalytics#resultTable',
      columnHeaders: columns.map((name) => ({
        name,
        columnType: name === 'day' ? 'DIMENSION' : 'METRIC',
        dataType: name === 'day' ? 'STRING' : 'INTEGER',
      })),
      // YouTube omits `rows` entirely when there is no data.
      ...(rows.length ? { rows } : {}),
    });
  });
}

export function analyticsError(status: number, reason: string) {
  return http.get(ANALYTICS_URL, () =>
    HttpResponse.json({ error: { code: status, errors: [{ reason }] } }, { status }),
  );
}
