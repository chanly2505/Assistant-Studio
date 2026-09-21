# 6. YouTube Integration Architecture

Read [12-constraints-and-limitations.md](12-constraints-and-limitations.md) §A–§D first. This
document is the design that follows from those limits.

## 6.1 Service decomposition

```
src/services/youtube/
  youtube-oauth.service.ts   authorize URL, code exchange, refresh, revoke
  token-vault.ts             AES-256-GCM envelope encryption, key rotation
  youtube-data.client.ts     channels / playlistItems / videos / commentThreads
  youtube-analytics.client.ts reports.query
  quota-guard.ts             cost accounting + circuit breaker
  mappers.ts                 raw payload → domain, Zod-validated
  sync/
    backfill-channel.job.ts
    sync-channel-stats.job.ts
    sync-videos.job.ts
    sync-video-stats.job.ts
    sync-analytics.job.ts
```

Every client method flows through one internal `request()` that handles auth injection, quota
accounting, timeouts, retries, error translation and logging. No method calls `fetch` directly.

## 6.2 Quota accounting — enforced, not hoped for

Costs are declared as data, not scattered through the code:

```ts
export const QUOTA_COST = {
  'channels.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
  'commentThreads.list': 1,
  'search.list': 100,     // never used — see below
} as const;
```

`quota-guard.ts`:

- **Reserves** units in a Redis counter (`yt:quota:<YYYY-MM-DD>`, PT-day aligned) *before* the call
  and reconciles after; `ApiQuotaLedger` in Postgres is the durable record, reconciled hourly.
- **Circuit breaker**: at 80% of the daily budget, only interactive user-triggered calls proceed and
  scheduled syncs defer to tomorrow. At 95%, everything but token refresh stops and the app serves
  cached data with a "data updates paused" banner. Degrade visibly; never fail silently.
- **Per-user fairness**: a per-user daily cap prevents one large channel from consuming the shared
  project quota.
- **`search.list` is banned** — the guard throws on it, and an ESLint `no-restricted-syntax` rule
  rejects the literal in source. Enumeration always goes through the uploads playlist.

## 6.3 Sync strategy

### Enumeration (quota-optimal)

```
channels.list(part=snippet,statistics,contentDetails, mine=true)     1 unit
  → contentDetails.relatedPlaylists.uploads = "UU…"
playlistItems.list(playlistId=UU…, maxResults=50, pageToken=…)       1 unit / 50 videos
  → collect videoIds
videos.list(id=<50 comma-separated ids>, part=snippet,statistics,
            contentDetails,status)                                   1 unit / 50 videos
```

A 500-video channel: 1 + 10 + 10 = **21 units** for a complete first sync. The same enumeration via
`search.list` would cost **1,000+**.

### Tiering

Recency dominates what creators care about, and old videos barely move.

| Tier | Selection | Stats refresh |
|---|---|---|
| `HOT` | published ≤ 30 days, or top 10 by recent views | daily |
| `WARM` | published ≤ 180 days | every 3 days |
| `COLD` | older | weekly |

Tier is recomputed nightly. A 500-video channel costs ~2 units/day steady-state instead of ~10.

### Delta detection

`playlistItems.list` returns newest-first. The incremental sync walks pages only until it hits a
`videoId` already stored **and** `publishedAt` older than `lastFullSyncAt`, then stops. Typical daily
cost: 1 unit. Full re-walk runs weekly to catch deletions, unlistings and late edits.

### Analytics

`youtubeAnalytics.reports.query` with `ids=channel==<id>`:

- **Channel dailies**: `dimensions=day`, metrics `views, estimatedMinutesWatched,
  averageViewDuration, subscribersGained, subscribersLost, likes, comments, shares`.
- **Video dailies**: `dimensions=day,video` filtered to a batch of video ids, adding
  `averageViewPercentage`.
- **Every run re-fetches a trailing 7-day window** and upserts on `(channelId|videoId, date)`,
  because YouTube revises recent days (§12C). Rows inside the revision window carry
  `isProvisional = true`.
- New connections backfill up to **365 days**, chunked and rate-limited across several worker runs so
  one large connect does not consume the day's request budget.
- The Analytics API has its **own quota, separate from the Data API** — confirm current limits in
  Google Cloud Console → APIs & Services → Quotas, and register them in the same guard.

## 6.4 Caching

| Layer | Contents | TTL |
|---|---|---|
| Redis | access tokens | `expires_in − 120s` |
| Redis | in-flight refresh mutex | 30s |
| Redis | idempotency: "already synced this hour" | 1h |
| **Postgres** | **all YouTube data the UI reads** | durable |
| HTTP | Google `ETag` on `channels.list`/`videos.list` | sent as `If-None-Match`; a 304 still costs quota but saves bandwidth and parse time |

The load-bearing cache is Postgres. Redis is a coordination tool, not the source of truth — a Redis
flush must degrade performance, never correctness.

## 6.5 Error handling matrix

| Condition | Detection | Action | User sees |
|---|---|---|---|
| 401 invalid credentials | status | refresh once, then `REAUTH_REQUIRED` | "Reconnect your channel" |
| `invalid_grant` on refresh | token endpoint | mark `REAUTH_REQUIRED`, pause syncs, notify | Reconnect card |
| 403 `insufficientPermissions` | reason field | mark connection, request incremental consent | "Grant analytics access" |
| 403 `quotaExceeded` | reason field | trip breaker, defer jobs to next PT day | "Updates paused, resuming soon" |
| 403 `forbidden` (not owner) | reason field | mark channel unmanageable, stop retrying | explains the channel isn't owned by this account |
| 404 | status | video deleted → set `deletedFromYouTubeAt`, keep history | "Removed from YouTube" |
| 429 | status | backoff + jitter, respect `Retry-After` | transparent |
| 5xx / timeout | status/abort | retry 3× exp. backoff, then fail the job (BullMQ retains) | stale-data banner |
| Malformed payload | Zod parse of the response | fail loudly, log payload shape only (no values) | `UPSTREAM_UNAVAILABLE` |

Every response is **parsed with Zod before mapping**. Trusting an upstream shape is how a schema
change becomes a production incident at 3am.

Timeouts: 10s data calls, 20s analytics, `AbortController` on all of them. Per-connection concurrency
capped so one channel's backfill cannot starve others.

## 6.6 What is deliberately not built

- **No upload / no editing of live YouTube metadata** (§12E). The product generates copy; the
  creator pastes it. The schema reserves `ContentProject.publishedVideoId` for a later phase.
- **No impressions/CTR** (§12C). Features that would need them are reframed as advice.
- **No comment moderation.** Reading comments is 1 unit; replying needs write scope. Out of v1.
