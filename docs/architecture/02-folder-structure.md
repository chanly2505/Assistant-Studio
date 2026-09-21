# 2. Folder Structure

```
studio-assistant/
├── app/                                  # Next.js App Router — UI + HTTP only
│   ├── [locale]/                         # locale segment: en | km | th | vi | zh
│   │   ├── (marketing)/                  # public: landing, pricing, privacy, terms
│   │   ├── (auth)/
│   │   │   ├── sign-in/page.tsx
│   │   │   └── error/page.tsx
│   │   └── (app)/                        # authenticated shell
│   │       ├── layout.tsx                # session guard + channel switcher
│   │       ├── dashboard/page.tsx
│   │       ├── channels/
│   │       │   ├── page.tsx              # connect / list / disconnect
│   │       │   └── [channelId]/
│   │       │       ├── page.tsx
│   │       │       ├── videos/page.tsx
│   │       │       ├── videos/[videoId]/page.tsx
│   │       │       ├── analytics/page.tsx
│   │       │       └── settings/page.tsx
│   │       ├── studio/                   # AI surfaces
│   │       │   ├── ideas/page.tsx
│   │       │   ├── titles/page.tsx
│   │       │   ├── description/page.tsx
│   │       │   ├── script/page.tsx
│   │       │   └── plan/page.tsx
│   │       ├── projects/
│   │       │   ├── page.tsx
│   │       │   └── [projectId]/page.tsx
│   │       ├── calendar/page.tsx
│   │       ├── usage/page.tsx
│   │       └── settings/page.tsx
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts   # Auth.js — login only
│   │   ├── youtube/oauth/
│   │   │   ├── start/route.ts            # channel connect — separate grant
│   │   │   └── callback/route.ts
│   │   ├── v1/                           # versioned JSON API
│   │   │   ├── channels/route.ts
│   │   │   ├── channels/[channelId]/route.ts
│   │   │   ├── channels/[channelId]/sync/route.ts
│   │   │   ├── channels/[channelId]/videos/route.ts
│   │   │   ├── channels/[channelId]/analytics/route.ts
│   │   │   ├── ai/ideas/route.ts
│   │   │   ├── ai/titles/route.ts
│   │   │   ├── ai/description/route.ts
│   │   │   ├── ai/script/route.ts
│   │   │   ├── ai/plan/route.ts
│   │   │   ├── ideas/route.ts
│   │   │   ├── projects/route.ts
│   │   │   ├── projects/[id]/route.ts
│   │   │   ├── calendar/route.ts
│   │   │   ├── settings/route.ts
│   │   │   └── usage/route.ts
│   │   ├── health/route.ts               # liveness
│   │   └── ready/route.ts                # DB + Redis reachability
│   ├── global-error.tsx
│   └── layout.tsx
│
├── src/
│   ├── domain/                           # pure — no I/O, no framework
│   │   ├── errors/
│   │   │   ├── app-error.ts              # AppError, ErrorCode enum
│   │   │   └── result.ts                 # Result<T>, ok(), err()
│   │   ├── youtube/                      # Channel, Video, AnalyticsRow, quota costs
│   │   ├── content/                      # ContentStatus machine, AssetKind
│   │   ├── ai/                           # Feature enum, PromptVersion, cost model
│   │   └── shared/                       # Locale, Paginated<T>, branded ids
│   │
│   ├── modules/                          # APPLICATION LAYER — one folder per use case group
│   │   ├── auth/
│   │   │   ├── get-current-user.ts
│   │   │   └── require-session.ts
│   │   ├── channels/
│   │   │   ├── start-channel-connect.ts
│   │   │   ├── complete-channel-connect.ts
│   │   │   ├── list-channels.ts
│   │   │   ├── disconnect-channel.ts
│   │   │   └── request-sync.ts
│   │   ├── videos/
│   │   ├── analytics/
│   │   ├── ai/
│   │   │   ├── generate-ideas.ts
│   │   │   ├── generate-titles.ts
│   │   │   ├── generate-description.ts
│   │   │   ├── generate-script.ts
│   │   │   ├── generate-plan.ts
│   │   │   └── check-ai-allowance.ts
│   │   ├── content/                      # ideas, projects, assets, status transitions
│   │   ├── calendar/
│   │   ├── settings/
│   │   └── usage/
│   │
│   ├── services/                         # INTEGRATION LAYER — one external system each
│   │   ├── youtube/
│   │   │   ├── youtube-data.client.ts    # channels/playlistItems/videos
│   │   │   ├── youtube-analytics.client.ts
│   │   │   ├── youtube-oauth.service.ts  # authz url, code exchange, refresh
│   │   │   ├── token-vault.ts            # AES-256-GCM encrypt/decrypt + rotation
│   │   │   ├── quota-guard.ts            # ledger + circuit breaker
│   │   │   ├── sync/                     # channel/video/analytics sync orchestration
│   │   │   ├── mappers.ts                # API payload -> domain (Zod-validated)
│   │   │   └── types.ts
│   │   ├── ai/
│   │   │   ├── ai-service.ts             # AIService interface (the abstraction)
│   │   │   ├── providers/openai.provider.ts
│   │   │   ├── providers/mock.provider.ts    # tests + local dev only
│   │   │   ├── prompts/                  # versioned templates, per feature per locale
│   │   │   ├── schemas/                  # Zod schemas for every structured output
│   │   │   ├── context-builder.ts        # the ONLY YouTube-data -> prompt path
│   │   │   └── cost.ts
│   │   ├── cache/redis.ts
│   │   ├── queue/                        # JobQueue interface + BullMQ impl
│   │   ├── ratelimit/
│   │   └── crypto/                       # envelope encryption primitives
│   │
│   ├── db/
│   │   ├── prisma.ts                     # singleton client
│   │   └── repositories/                 # every method takes userId or a proven scope
│   │
│   ├── lib/
│   │   ├── auth/                         # Auth.js config, callbacks, session helpers
│   │   ├── api/
│   │   │   ├── with-api.ts               # auth + validate + rate-limit + error map
│   │   │   ├── responses.ts
│   │   │   └── error-map.ts              # AppError -> HTTP
│   │   ├── logger/                       # pino + redaction + correlation id
│   │   ├── audit/
│   │   ├── env.ts                        # Zod-parsed env, server-only
│   │   └── i18n/
│   │
│   └── worker/
│       ├── index.ts                      # worker entry point
│       ├── jobs/                         # one file per job type
│       └── schedulers/                   # repeatable job registration
│
├── messages/                             # translation catalogues
│   ├── en.json  km.json  th.json  vi.json  zh.json
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── tests/
│   ├── unit/
│   ├── integration/                      # real Postgres, mocked HTTP
│   ├── api/                              # route handler contract tests
│   ├── e2e/                              # Playwright
│   ├── fixtures/                         # recorded Google/OpenAI payloads
│   └── helpers/                          # db reset, session factory, fake OIDC
│
├── components/                           # presentational only
│   └── ui/                               # design system primitives
│
├── docs/architecture/                    # this folder
├── .env.example                          # names only, never values
└── docker-compose.yml                    # local postgres + redis
```

## Placement rules

- **A file under `app/` never imports Prisma.** ESLint boundary rule; CI fails on violation.
- **A file under `src/services/` never imports a repository.** Services are stateless adapters; the
  use case owns persistence.
- **Anything reading `process.env` imports `src/lib/env.ts`** — the only module allowed to touch it,
  and it is `server-only` and Zod-validated at boot, so a missing variable crashes at startup rather
  than at 3am inside a request.
- **`src/worker/` and `app/` are peers**, both thin entry points over `src/modules/`. A job and an
  HTTP route that do the same thing call the same use case.
