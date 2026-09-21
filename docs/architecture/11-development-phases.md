# 11. Development Phases

Each phase ends in something **demonstrable and tested**. No phase ships a screen backed by fake
data. Where an integration is not ready, the route returns a typed error and the UI shows an honest
empty state.

Durations assume one focused full-stack developer. Treat them as sequencing, not commitments.

---

### Phase 0 — Prerequisites *(blocking; ~half a day)*

Install **Node 20/22 LTS**, **pnpm** (via corepack), and **Docker Desktop** — none are present on
this machine (§12I). Create the three Google Cloud projects, enable the YouTube Data API v3 and
YouTube Analytics API, create OAuth clients and redirect URIs, and provision an OpenAI key.

**Done when:** `node -v`, `pnpm -v`, and `docker compose up -d` all succeed.

### Phase 1 — Foundation *(2–3 days)*

Next.js + TypeScript strict, ESLint with boundary rules, Prettier, Vitest, Playwright scaffold,
`docker-compose.yml` (Postgres + Redis), `src/lib/env.ts` with Zod parsing, pino logger with
redaction, `AppError`/`Result`, `withApi` wrapper, `next-intl` with the five locale files, CI
pipeline with every gate from §8.8.

**Done when:** `/api/health` returns 200, an intentionally broken env crashes at boot with a clear
message, the logger redaction test passes, and CI is green on an empty app.

### Phase 2 — Auth *(3–4 days)*

Auth.js v5, Google provider, **login scopes only**, Prisma adapter, database sessions. `User`,
`Account`, `Session`, `UserSettings`. Protected layout, sign-in/sign-out, `AuditLog` writes,
authorization test harness and the table-driven authz matrix.

**Done when:** a user signs in with Google, a session row exists, anonymous access to `/dashboard`
redirects, and the authz suite passes.

### Phase 3 — YouTube connection *(4–5 days)* ⚠ start Google verification **now**

`YouTubeConnection`, `OAuthState`, `TokenVault` (AES-256-GCM + AAD + key version), the separate
channel-connect OAuth routes with PKCE and session-bound state, token refresh with mutex and
`invalid_grant` → `REAUTH_REQUIRED`, `channels.list`, disconnect with upstream revocation.

**In parallel, not after:** submit the OAuth consent screen for verification — homepage, privacy
policy, demo video. This has a 2–6 week clock and everything downstream of public launch waits on
it (§12A).

**Done when:** a real channel connects, the refresh token is encrypted at rest, `SELECT` on the table
shows ciphertext, revoke-then-call produces `REAUTH_REQUIRED`, and the grant-injection test passes.

### Phase 4 — Data sync *(5–6 days)*

BullMQ worker process, `quota-guard` with ledger and breaker, uploads-playlist enumeration, batched
`videos.list`, `YouTubeVideo` + snapshot tables, tiering, delta sync, `SyncJob` progress, the videos
UI reading **only** from Postgres.

**Done when:** a 300+ video channel backfills within the asserted unit budget, a second run adds
nothing and spends nothing, and the breaker trips correctly in an integration test.

### Phase 5 — Analytics *(4–5 days)*

`youtubeAnalytics.reports.query`, channel and video daily tables, trailing-7-day re-fetch with
upsert, `isProvisional`, 365-day chunked backfill, charts with an explicit "data through <date>"
marker and an honest note about what YouTube does not expose (§12C).

**Done when:** numbers reconcile against YouTube Studio for the same date range, and a double sync
produces no duplicate rows.

### Phase 6 — AI *(6–7 days)*

`AIService` interface, OpenAI and mock providers, versioned prompts per locale, structured outputs
with double validation, `AIContextBuilder` with its forbidden-field tests, `AIGeneration` and
`UsageCounter`, allowance checks, response cache, streaming script generation with usage finalised
on disconnect, the five AI surfaces, prompt-injection regression suite.

**Done when:** all five features return schema-valid output, a user at their limit gets
`AI_LIMIT_REACHED` **with no provider call made**, and an interrupted stream still records usage.

### Phase 7 — Content management *(5–6 days)*

`ContentIdea`, `ContentProject`, `ContentAsset` with versioning, `ContentStatusEvent`,
`CalendarEntry`, idea → project promotion, status board, calendar view, asset version comparison and
selection.

**Done when:** an AI idea becomes a project, gathers titles/description/script as versioned assets,
moves through statuses with recorded history, and appears on the calendar.

### Phase 8 — Localisation & settings *(3–4 days)*

Complete `en.json`, locale switcher, locale-aware dates and numbers, translated **error messages**
end to end, user and channel settings, onboarding for non-technical users, usage page.

**Done when:** the locale-switch e2e test passes *including error messages*, and a missing key fails
CI rather than rendering a raw key to a user.

### Phase 9 — Hardening *(4–5 days)*

CSP with nonces and the full security header set, rate limits on every surface, the complete
Playwright suite with the fake OIDC provider, Sentry, dashboards and alerts, backup restore
rehearsal, load test, accessibility pass, data export and account deletion.

**Done when:** the §10.8 checklist is green except the items gated on Google.

### Phase 10 — Launch *(gated by Google, not by code)*

Verification approved, compliance audit submitted if a quota increase is needed, closed beta under
the 100-user cap, then open. Non-English locales released only after native review (§12G).

---

## Critical path

```
Phase 0 ─ 1 ─ 2 ─ 3 ─┬─ 4 ─ 5 ─┐
                     │         ├─ 7 ─ 8 ─ 9 ─ 10
                     └─── 6 ───┘
                     │
                     └─ Google verification (2–6 weeks, wall-clock, runs in parallel) ──┘
```

Phases 4/5 and 6 are independent after Phase 3 and can be interleaved. **Google verification is the
longest pole in the tent and is the only thing that must start earlier than it appears to need to.**

## Suggested order for Phase 2 onward

If you want to see value sooner at some cost to sequencing purity, Phase 6 (AI) can run immediately
after Phase 2 using only user-typed context, with channel-aware prompts switched on when Phase 4
lands. `AIContextBuilder` is designed to degrade to a minimal context when no channel is connected,
so this needs no rework.

---

**Phase 1 ends here. Say the word and I'll start Phase 0/1 implementation** — beginning with the
prerequisite installs, the repository scaffold, `env.ts`, the logger, the error taxonomy, the
`withApi` wrapper, and a green CI pipeline.
