# 3. Database Architecture

PostgreSQL 16 + Prisma. Normalised to 3NF, with deliberate, documented denormalisation only in the
time-series tables.

## 3.1 Departures from the suggested entity list

The brief's list was a starting point. Analysis changed five things:

1. **`YouTubeConnection` added between `User` and `YouTubeChannel`.** An OAuth grant is not a
   channel. One user may hold several grants; one grant may in principle surface several channels;
   a grant can be revoked while the channel rows and their history stay. Without this table, a
   revoked token forces you to delete channel data. This is the most important schema decision in
   the product.

2. **`ContentIdea` / `ContentProject` / `ContentScript` collapsed differently.** `ContentScript` as
   its own table does not generalise — titles, descriptions, tags and scripts are all *generated
   text attached to a project, in a locale, with versions*. One `ContentAsset` table with a `kind`
   discriminator replaces three near-identical tables and makes "show me every version of this
   title" a single query. `ContentIdea` stays separate because an idea exists **before** a project
   and may never become one.

3. **`VideoAnalytics` / `ChannelAnalytics` split into snapshots vs. dailies.** Two genuinely
   different things were hiding under one name:
   - *Snapshots* (`ChannelStatsSnapshot`, `VideoStatsSnapshot`): cumulative counters from the **Data
     API**, true as of an observation instant. Append-only.
   - *Dailies* (`ChannelAnalyticsDaily`, `VideoAnalyticsDaily`): per-day metrics from the
     **Analytics API**, keyed by calendar date, and **revisable** for ~3 days (see
     [12-constraints-and-limitations.md](12-constraints-and-limitations.md)). Upserted.

   Modelling these as one table makes correct re-sync impossible.

4. **`AIUsage` renamed `AIGeneration` and made the generation record itself**, not a counter. It
   stores the request, the prompt version, the model, tokens, cost and outcome — so every stored
   piece of content can point back at exactly what produced it. Fast counters live in
   `UsageCounter`, derived from it.

5. **`ContentCalendar` is not a table.** A calendar is a *view over dated things*. A
   `CalendarEntry` row exists only for items with no project behind them (reminders, "film B-roll").
   Projects appear on the calendar via `ContentProject.scheduledFor`. A separate join table would
   have to be kept in sync with project dates — a guaranteed source of drift.

## 3.2 Entities

### Identity & auth

```
User            id, email(unique, citext), emailVerified, name, image,
                locale, timezone, planKey, status, createdAt, updatedAt, deletedAt
Account         Auth.js — provider, providerAccountId, login tokens ONLY
                @@unique([provider, providerAccountId])
Session         sessionToken(unique), userId, expires
VerificationToken
UserSettings    userId(unique 1-1), defaultChannelId?, contentLanguage, brandVoice,
                emailDigest, onboardingStep, updatedAt
```

`Account` is Auth.js's table and holds the **login** grant. YouTube tokens never go here — see
[05-authentication-architecture.md](05-authentication-architecture.md).

### YouTube

```
YouTubeConnection
                id, userId → User, googleSub, googleEmail,
                encryptedRefreshToken, encryptionKeyVersion,
                scopes String[], status(ACTIVE|REAUTH_REQUIRED|REVOKED),
                grantedAt, lastRefreshedAt, lastRefreshError?, revokedAt
                @@unique([userId, googleSub])
                @@index([status])

YouTubeChannel  id, connectionId → YouTubeConnection, userId → User (denormalised for scoping),
                youtubeChannelId(unique), title, handle?, description?,
                thumbnailUrl?, country?, uploadsPlaylistId,
                publishedAt, syncStatus, lastFullSyncAt?, lastStatsSyncAt?,
                lastAnalyticsDate?, connectedAt, disconnectedAt?
                @@index([userId, disconnectedAt])

ChannelSettings channelId(unique 1-1), niche?, targetAudience?, brandVoice?,
                keywords String[], contentLanguage, uploadCadence?, notes?

ChannelStatsSnapshot
                id, channelId → YouTubeChannel, capturedAt,
                subscriberCount BigInt, viewCount BigInt, videoCount Int,
                subscriberCountIsRounded Boolean
                @@index([channelId, capturedAt(desc)])

YouTubeVideo    id, channelId → YouTubeChannel, youtubeVideoId(unique),
                title, description, publishedAt, durationSeconds,
                privacyStatus, thumbnailUrl?, tags String[], categoryId?,
                defaultLanguage?, isShort Boolean, syncTier(HOT|WARM|COLD),
                lastStatsSyncAt?, firstSeenAt, deletedFromYouTubeAt?
                @@index([channelId, publishedAt(desc)])

VideoStatsSnapshot
                id, videoId → YouTubeVideo, capturedAt,
                viewCount BigInt, likeCount BigInt?, commentCount BigInt?
                @@index([videoId, capturedAt(desc)])

ChannelAnalyticsDaily
                id, channelId, date(Date),
                views, estimatedMinutesWatched, averageViewDuration,
                subscribersGained, subscribersLost, likes, comments, shares,
                fetchedAt, isProvisional Boolean
                @@unique([channelId, date])

VideoAnalyticsDaily
                id, videoId, date(Date),
                views, estimatedMinutesWatched, averageViewDuration,
                averageViewPercentage, likes, comments, shares,
                subscribersGained, fetchedAt, isProvisional Boolean
                @@unique([videoId, date])
```

`isProvisional` is set while the row falls inside the ~3-day revision window, so the UI can mark it.

### Content

```
ContentIdea     id, userId, channelId?, title, angle?, hook?, format?,
                keywords String[], rationale?, source(AI|USER),
                aiGenerationId?, status(SAVED|PROMOTED|ARCHIVED),
                projectId?  → set when promoted,
                createdAt, archivedAt?
                @@index([userId, status, createdAt(desc)])

ContentProject  id, userId, channelId?, ideaId?, title, locale,
                status(IDEA|SCRIPTING|FILMING|EDITING|SCHEDULED|PUBLISHED|ARCHIVED),
                scheduledFor?, publishedAt?, publishedVideoId?  → YouTubeVideo (future use),
                notes?, createdAt, updatedAt, deletedAt?
                @@index([userId, status])
                @@index([userId, scheduledFor])

ContentAsset    id, projectId → ContentProject, kind(TITLE|DESCRIPTION|SCRIPT|TAGS|
                                                     THUMBNAIL_BRIEF|CHAPTERS),
                locale, body Text, version Int, isSelected Boolean,
                aiGenerationId?, createdBy(AI|USER), createdAt
                @@unique([projectId, kind, locale, version])
                @@index([projectId, kind, isSelected])

CalendarEntry   id, userId, channelId?, title, entryType(REMINDER|TASK|NOTE),
                startsAt, endsAt?, allDay, status, createdAt
                @@index([userId, startsAt])

ContentStatusEvent
                id, projectId, fromStatus?, toStatus, changedByUserId?, note?, createdAt
```

`ContentStatusEvent` gives "track content status" real history instead of a single mutable column,
and feeds the audit trail.

### AI, usage, ops

```
AIGeneration    id, userId, channelId?, projectId?,
                feature(IDEAS|TITLES|DESCRIPTION|SCRIPT|PLAN),
                provider, model, promptVersion, locale,
                inputHash,                       → response cache key
                inputTokens, outputTokens, costMicros,
                latencyMs, status(OK|INVALID_OUTPUT|PROVIDER_ERROR|TIMEOUT|FILTERED),
                errorCode?, outputJson Json?, createdAt
                @@index([userId, createdAt(desc)])
                @@index([userId, feature, inputHash])

UsageCounter    id, userId, periodStart(Date), feature, count, tokensUsed, costMicros
                @@unique([userId, periodStart, feature])

Plan            key(unique), name, monthlyGenerations Json, maxChannels,
                maxScriptsPerMonth, features Json, isActive

ApiQuotaLedger  id, api(YOUTUBE_DATA|YOUTUBE_ANALYTICS|OPENAI), day(Date),
                unitsUsed BigInt, requestCount
                @@unique([api, day])

SyncJob         id, channelId, jobType, status, startedAt?, finishedAt?,
                itemsProcessed, quotaUnitsUsed, errorCode?, errorMessage?, attempt
                @@index([channelId, jobType, startedAt(desc)])

AuditLog        id, userId?, actorType(USER|SYSTEM|WORKER), action,
                resourceType, resourceId?, ipHash?, userAgent?,
                metadata Json, createdAt
                @@index([userId, createdAt(desc)])
                @@index([action, createdAt(desc)])

OAuthState      state(unique), userId, codeVerifier, redirectTo?, expiresAt
                → short-lived CSRF/replay protection for the channel-connect flow
```

## 3.3 Relationship summary

```
User 1─* YouTubeConnection 1─* YouTubeChannel 1─* YouTubeVideo
                                     │                  ├─* VideoStatsSnapshot
                                     │                  └─* VideoAnalyticsDaily
                                     ├─1 ChannelSettings
                                     ├─* ChannelStatsSnapshot
                                     └─* ChannelAnalyticsDaily
User 1─1 UserSettings
User 1─* ContentIdea  ─0..1─> ContentProject 1─* ContentAsset
                                             └─* ContentStatusEvent
User 1─* CalendarEntry
User 1─* AIGeneration  ─0..1─> ContentAsset / ContentIdea (provenance)
User 1─* AuditLog
```

## 3.4 Integrity and lifecycle rules

- **Cascade deletes** from `User` through connections, channels, videos, snapshots, analytics,
  projects and assets. `AuditLog` and `AIGeneration` **do not cascade** — `userId` becomes null on
  account deletion so operational and billing history survives, with no PII left attached.
- **Soft delete** (`deletedAt`) on `User` and `ContentProject` only. Everything else is hard-deleted
  or cascaded. Partial indexes exclude soft-deleted rows.
- **Disconnecting a channel** sets `disconnectedAt`; it does not delete history. Reconnecting the
  same `youtubeChannelId` reuses the row and resumes from `lastAnalyticsDate`, which saves a full
  backfill and its quota.
- **`youtubeChannelId` and `youtubeVideoId` are globally unique**, not unique-per-user. Two users
  connecting the same channel (a brand with two managers) is a legitimate case; it is handled by a
  join of `YouTubeChannel` ownership rather than duplicated video rows — resolved in Phase 4 with a
  `ChannelMembership` table if demand appears. Until then a second connection to the same channel is
  rejected with a clear message. Documented rather than silently broken.
- **`BigInt` for all YouTube counters.** `viewCount` exceeds `int4` on real channels.
- **Money as integer `costMicros`.** No floats anywhere near cost.
- **`Date` (not timestamp) for analytics keys.** All analytics dates are YouTube's reporting dates
  in **UTC (PT for YouTube's own accounting)**; the timezone is documented on the column and never
  converted. Display-time conversion uses `User.timezone`.

## 3.5 Indexing and growth

The time-series tables dominate growth: a channel with 500 videos produces ~500 `VideoAnalyticsDaily`
rows per day. At 1,000 channels that is ~150M rows/year.

Plan, in order:
1. Composite indexes exactly matching the read patterns above (channel + date desc).
2. Retention: raw dailies kept 400 days, then rolled into monthly aggregates by a worker job.
3. Monthly range partitioning on `VideoAnalyticsDaily` / `ChannelAnalyticsDaily` when either exceeds
   ~50M rows. Prisma does not manage partitions, so this lands as a raw-SQL migration — the schema
   is designed so that change is additive.

## 3.6 Migrations

`prisma migrate` with reviewed SQL, forward-only, and an expand/contract discipline for anything
destructive: add the new column, backfill in a job, switch reads, drop the old column in a later
release. Migrations run as a CI gate before the new app version is promoted, never on app boot.
