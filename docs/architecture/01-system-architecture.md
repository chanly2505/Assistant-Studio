# 1. System Architecture

## 1.1 Shape of the system

Four processes, one database, one Redis.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (React Server Components + minimal client islands)          │
│  - no API keys, no tokens, no business rules                         │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS, httpOnly session cookie
┌───────────────▼──────────────────────────────────────────────────────┐
│  Next.js server (App Router)                                         │
│                                                                      │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐   │
│  │ Route        │  │ Server        │  │ Auth.js handlers         │   │
│  │ handlers     │  │ Actions       │  │ + YouTube OAuth routes   │   │
│  │ /api/v1/*    │  │ (forms)       │  │                          │   │
│  └──────┬───────┘  └───────┬───────┘  └──────────┬───────────────┘   │
│         └──────────────────┴─────────────────────┘                   │
│                            │  (single entry point per operation)     │
│  ┌─────────────────────────▼───────────────────────────────────────┐ │
│  │  APPLICATION LAYER — use cases (src/modules/**)                 │ │
│  │  generateTitles · connectChannel · syncChannel · listVideos …   │ │
│  │  owns: authorization, quota checks, transactions, audit writes  │ │
│  └───────┬──────────────────────────────────┬──────────────────────┘ │
│          │                                  │                        │
│  ┌───────▼────────────┐          ┌──────────▼─────────────────────┐  │
│  │ SERVICE LAYER      │          │ DATA LAYER                     │  │
│  │ YouTubeService     │          │ repositories (Prisma)          │  │
│  │ AnalyticsService   │          │ every query scoped by userId   │  │
│  │ AIService          │          └──────────┬─────────────────────┘  │
│  │ TokenVault         │                     │                        │
│  │ CacheService       │                     │                        │
│  └───────┬────────────┘                     │                        │
└──────────┼──────────────────────────────────┼────────────────────────┘
           │                                  │
   ┌───────▼────────┐  ┌──────────────┐  ┌────▼──────────┐
   │ Google / YT    │  │ OpenAI       │  │ PostgreSQL    │
   │ Data+Analytics │  │              │  │               │
   └────────────────┘  └──────────────┘  └───────────────┘
           ▲                                  ▲
┌──────────┴──────────────────────────────────┴────────────────────────┐
│  Worker process (BullMQ)  — same src/, different entry point         │
│  channel.sync · video.sync · analytics.sync · token.refresh          │
│  ai.longjob (script generation) · quota.rollup · audit.retention     │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                         ┌──────▼──────┐
                         │   Redis     │ cache · queues · rate limits
                         └─────────────┘
```

## 1.2 Layer contract

| Layer | May import | May **not** import | Rule |
|---|---|---|---|
| UI (`app/**`, `components/**`) | use cases, DTO types, i18n | Prisma, service clients, `process.env` | A component that calculates anything beyond formatting is a bug |
| Application (`src/modules/**`) | services, repositories, domain | `next/*`, React, `Request`/`Response` | Framework-agnostic. Takes plain input, returns `Result<T>` |
| Services (`src/services/**`) | HTTP clients, domain types | repositories, use cases | Knows *one* external system. Never touches the DB |
| Data (`src/db/**`) | Prisma | services, use cases | Returns domain shapes, not raw Prisma rows, at module boundaries |
| Domain (`src/domain/**`) | nothing | everything | Pure types + pure functions. 100% unit-testable |

Enforced mechanically by `eslint-plugin-boundaries` in CI, not by convention. A violation fails the
build.

## 1.3 Why the worker is a separate process

Sync jobs walk paginated YouTube responses and can run for minutes; script generation streams for
tens of seconds. Serverless function timeouts make both unreliable and expensive. The worker is a
long-lived Node process sharing the same `src/` tree, started with a different entry point. This is
also what makes the quota circuit breaker meaningful — a single process can hold an accurate
in-memory view backed by Redis.

If the deployment target must stay fully serverless, the fallback is Vercel Cron + QStash with jobs
chunked to fit inside the timeout; see [10-deployment-architecture.md](10-deployment-architecture.md).
The queue abstraction (`JobQueue` interface) makes that a service swap, not a rewrite.

## 1.4 Read path vs. write path

**Reads are never live.** A dashboard page reads Postgres only. No page render ever calls YouTube or
OpenAI. This is what keeps the product inside quota and makes page loads fast and deterministic
(and testable without network mocks).

**Freshness** comes from the worker:

| Data | Refresh | Trigger |
|---|---|---|
| Channel metadata + stats snapshot | daily | cron + manual "refresh" (rate-limited) |
| Video list (uploads playlist) | daily, delta-only | cron |
| Video stats snapshots | daily for recent 50, weekly for tail | cron, tiered |
| Channel/video analytics dailies | daily, trailing 7-day re-fetch | cron |
| On connect | full backfill | queued immediately after OAuth callback |

The UI shows `lastSyncedAt` and a "data through" date on every surface that displays YouTube
numbers. Users see the truth about freshness rather than a number that silently ages.

## 1.5 Result and error flow

Use cases return a discriminated union rather than throwing for expected conditions:

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
```

`AppError` carries a stable machine `code`, an HTTP status, an **i18n message key** (not an English
string), a `retryable` flag, and a non-serialised `cause`. The HTTP boundary maps it to a safe JSON
body; the UI renders the key through `next-intl`. Unexpected throws are caught by the boundary
wrapper, logged with full detail plus a correlation id, reported to Sentry, and returned to the user
as `INTERNAL` with that correlation id and nothing else. See
[04-api-architecture.md](04-api-architecture.md).

## 1.6 Cross-cutting concerns

- **Correlation id** — generated per request, propagated into the logger, into every outbound API
  call's log line, into enqueued jobs, and returned in the `x-request-id` response header.
- **Logging** — `pino`, JSON, with a redaction allowlist. Token fields are structurally impossible
  to log: `TokenVault` returns branded `SecretString` values whose `toJSON`/`toString` emit
  `[redacted]`.
- **Audit** — every state-changing use case writes an `AuditLog` row inside the same transaction as
  the change it records.
- **i18n** — locale resolved from `UserSettings.locale`, falling back to the `Accept-Language`
  header, falling back to `en`. Server-rendered strings come from the same message catalogue as
  client ones.
