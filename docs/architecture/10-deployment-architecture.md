# 10. Deployment Architecture

## 10.1 Environments

Three, fully isolated — **including separate Google Cloud projects**, because YouTube API quota is
per project (§12B). Sharing a project means a load test in staging exhausts production's quota.

| | Local | Staging | Production |
|---|---|---|---|
| App | `pnpm dev` | Vercel preview/staging | Vercel production |
| DB | Docker Postgres | Neon branch | Neon / RDS, PITR enabled |
| Redis | Docker | Upstash | Upstash / ElastiCache |
| Worker | `pnpm worker` | Railway/Fly service | Railway/Fly/ECS, ≥2 replicas |
| Google project | `ysa-dev` | `ysa-staging` | `ysa-prod` (the verified one) |
| OAuth redirect | `http://localhost:3000/...` | staging domain | production domain |
| AI provider | `mock` by default | real, low limits | real |

## 10.2 Topology

```
            Vercel Edge (CDN, TLS, WAF)
                    │
        ┌───────────▼────────────┐
        │  Next.js (serverless)  │  autoscaling, stateless
        └───────┬────────────────┘
                │
     ┌──────────┼───────────────┐
     ▼          ▼               ▼
 Postgres     Redis         Google / OpenAI
 (pooled)   (cache/queue)
     ▲          ▲
     └──────┬───┘
   Worker service (always-on, ≥2 replicas)
   BullMQ consumers + repeatable schedulers
```

**Connection pooling is mandatory.** Serverless functions open connections per invocation and will
exhaust Postgres under load; use PgBouncer / Neon's pooler in transaction mode, with Prisma's
`?pgbouncer=true&connection_limit=1`. Migrations connect to the **direct** URL, not the pooled one.

## 10.3 Why the worker is not serverless

Backfills page through hundreds of videos; script generation streams for tens of seconds; repeatable
schedulers need a durable clock. A long-lived process on Railway/Fly/ECS with BullMQ gives retries
with backoff, dead-letter queues, concurrency control, and an accurate in-process view of the quota
breaker.

**Fallback if fully-serverless is required:** Vercel Cron triggers chunked job routes, with QStash or
SQS for fan-out and each unit of work sized to fit the timeout. The `JobQueue` interface in
`src/services/queue/` makes this a provider swap. The cost is more complex chunking and weaker
quota-breaker accuracy — documented so the trade-off is chosen, not stumbled into.

## 10.4 Scheduled jobs

| Job | Cadence | Notes |
|---|---|---|
| `analytics.sync` | daily 04:00 PT | after YouTube's reporting boundary; trailing 7-day window |
| `videos.sync` (delta) | daily | ~1 unit/channel |
| `videos.sync` (full) | weekly | catches deletions/unlistings |
| `stats.sync` | daily, tiered | HOT/WARM/COLD |
| `tier.recompute` | nightly | before `stats.sync` |
| `quota.rollup` | hourly | reconcile Redis → `ApiQuotaLedger` |
| `usage.reconcile` | hourly | reconcile Redis → `UsageCounter` |
| `token.health` | 6-hourly | proactively refresh soon-to-expire grants, surface `REAUTH_REQUIRED` early |
| `retention.purge` | daily | logs, raw AI outputs, deleted accounts |
| `analytics.rollup` | monthly | dailies > 400 days → monthly aggregates |

All jobs are **idempotent and resumable**, keyed by `(channelId, jobType, targetDate)`, with progress
recorded in `SyncJob` so a crashed run resumes rather than restarts. Jobs are spread across the hour
with jitter so the whole customer base does not hit Google in the same minute.

## 10.5 CI/CD

```
PR    → typecheck · lint (+boundaries) · unit · integration (ephemeral PG+Redis)
      · gitleaks · bundle-secret grep · migration drift check · preview deploy
main  → migrate (direct URL, expand-only) → deploy app → deploy worker → smoke tests
      → Playwright against staging → promote
```

Rules:
- **Migrations run as a pipeline step, never on app boot.** Two booting instances racing a migration
  is a corruption incident.
- **Expand/contract only.** Additive migration ships first; the destructive half ships a release
  later, after the old code is gone. This keeps rollback possible — a rollback that cannot undo a
  dropped column is not a rollback.
- Worker deploys after the app, with graceful shutdown: stop accepting jobs, finish in-flight work,
  `SIGTERM` grace of 60s.

## 10.6 Observability

| Signal | Tool |
|---|---|
| Errors | Sentry (app + worker), `sendDefaultPii: false`, release tagging |
| Logs | pino JSON → platform log drain (Better Stack / Datadog), queryable by correlation id |
| Metrics | quota units used vs. budget, sync success rate, sync lag, AI spend/day, AI schema-failure rate, `REAUTH_REQUIRED` count, p95 route latency, queue depth and age |
| Uptime | external probe on `/api/health` and `/api/ready` |

Alerts that page someone:
- YouTube quota > 80% before 18:00 PT
- Daily AI spend > threshold
- Queue oldest-job age > 2 hours
- Sync failure rate > 10% over 30 min
- `REAUTH_REQUIRED` rate spike (usually means a config or verification-status change — this is the
  alert that catches the 7-day test-mode token expiry described in §12A)
- 5xx rate > 1% over 5 min

Alerts that do **not** page: an individual user's `invalid_grant`. That is expected product state.

## 10.7 Backup and recovery

- Postgres PITR with 7-day retention; **restore rehearsed quarterly** into a scratch database — an
  untested backup is a hypothesis.
- Redis is treated as disposable; losing it costs a token-cache warm-up and some rate-limit
  precision, never data.
- `TOKEN_ENCRYPTION_KEY` is backed up separately from the database, in a different trust boundary.
  Losing it means every user must reconnect their channel; keeping it next to the data defeats the
  encryption. This is documented in the runbook and the two backups are never co-located.
- RPO ≤ 5 min, RTO ≤ 1 hour.

## 10.8 Release checklist for public launch

1. Google OAuth consent screen in **Production** status, verification approved (§12A).
2. YouTube API Services compliance audit submitted if quota above default is needed (§12B).
3. Privacy policy and terms live, naming Google user data and its Limited Use handling.
4. Production Google project quota confirmed and alerting wired to the real numbers.
5. Rate limits and AI spend breaker load-tested at expected peak.
6. Backup restore rehearsed; key backup verified in a separate store.
7. Non-English locales reviewed by native speakers or left behind their feature flag (§12G).
