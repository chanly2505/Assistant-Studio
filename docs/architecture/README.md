# YouTube Studio Assistant — Architecture (Phase 1)

Status: **design only — no implementation yet.**

| # | Document |
|---|---|
| 01 | [System architecture](01-system-architecture.md) |
| 02 | [Folder structure](02-folder-structure.md) |
| 03 | [Database architecture](03-database-architecture.md) |
| 04 | [API architecture](04-api-architecture.md) |
| 05 | [Authentication & authorization](05-authentication-architecture.md) |
| 06 | [YouTube integration](06-youtube-integration-architecture.md) |
| 07 | [AI architecture](07-ai-architecture.md) |
| 08 | [Security architecture](08-security-architecture.md) |
| 09 | [Testing strategy](09-testing-strategy.md) |
| 10 | [Deployment architecture](10-deployment-architecture.md) |
| 11 | [Development phases](11-development-phases.md) |
| 12 | [Constraints & limitations](12-constraints-and-limitations.md) — **read first** |

## Decisions locked in Phase 1

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript `strict` |
| Auth | Auth.js v5, Google provider, **database sessions** |
| YouTube auth | **Separate incremental OAuth grant**, not the login grant |
| DB | PostgreSQL + Prisma |
| Cache / queue / rate limit | Redis + BullMQ |
| Background work | Dedicated long-running worker process (not serverless functions) |
| Validation | Zod at every boundary (HTTP in, DB out to client, AI out) |
| i18n | `next-intl`, locale-segment routing, zero hard-coded UI strings |
| Logging | `pino` structured JSON + Sentry |
| Tests | Vitest (unit/integration) + Supertest-style route tests + Playwright (e2e) |

## Non-negotiable rules carried into every later phase

1. No business logic in React components. Components call use cases; use cases call services and repositories.
2. No secret ever reaches the client bundle. Server-only modules are marked with the `server-only` package so a wrong import fails the build.
3. No fabricated API responses. Where a real integration is not wired yet, the service interface exists and the route returns a typed `NOT_IMPLEMENTED` error — never fake data dressed as real data.
4. Every repository query is scoped by `userId`. Ownership is proven in SQL, not in the UI.
5. OAuth tokens are encrypted at rest and never logged, never serialised into a response, never sent to the AI provider.
