# YouTube Studio Assistant

Helps creators plan, write and understand a YouTube channel.
Architecture and constraints: [`docs/architecture/`](docs/architecture/README.md). Read
[§12 Constraints & Limitations](docs/architecture/12-constraints-and-limitations.md) first.

**Status:** Phases 1–7 are done: foundation, Google sign-in, YouTube channel connection,
background sync of videos and statistics, analytics, the AI Studio tools, and content management
(ideas, projects with versioned titles/descriptions/scripts, status history, calendar), and
localisation and settings (Home with getting-started steps, Settings, Usage; Khmer, Thai,
Vietnamese and Chinese as hidden drafts awaiting native review, see
[`messages/README.md`](messages/README.md)).

**Just want to run it?** Follow [`docs/RUNNING.md`](docs/RUNNING.md).

## Requirements

- Node.js ≥ 20.11 (22 LTS recommended)
- pnpm 9 (`corepack enable`)
- PostgreSQL 16, from **either** the vendored binaries (`pnpm db:start`, no Docker needed) **or** `docker compose up -d`
- Valkey 8 or Redis ≥ 6.2 for the job queue and shared rate limits: `pnpm redis:start` (finds
  `valkey-server`/`redis-server`, including `~/.local/valkey/bin`) **or** `docker compose up -d redis`

## Setup

```bash
pnpm install
cp .env.example .env            # local values; never commit
cp .env.example .env.test       # then set NODE_ENV=test and use the *_test database
pnpm db:start                   # PostgreSQL 16 on 127.0.0.1:5433 (creates dev + test DBs)
pnpm db:migrate                 # apply migrations to the dev database
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/studio_assistant_test pnpm db:migrate:deploy
pnpm db:seed                    # plans + two development users
pnpm redis:start                # Valkey/Redis on 127.0.0.1:6379
pnpm dev                        # web app: http://localhost:3000
pnpm worker                     # background sync (separate terminal)
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm verify` | typecheck + lint + tests (the CI gate) |
| `pnpm test:e2e` | Playwright in your installed Chrome (own port 3100, build folder and database) |
| `pnpm test` / `test:coverage` | Vitest (real PostgreSQL, Prisma never mocked) |
| `pnpm lint` | includes architectural boundary rules |
| `pnpm format` / `format:check` | Prettier |
| `pnpm db:start` / `stop` / `status` / `nuke` | local PostgreSQL lifecycle |
| `pnpm redis:start` / `stop` / `status` | local Valkey/Redis lifecycle |
| `pnpm worker` / `worker:dev` | background worker (sync jobs + hourly scheduler) |
| `pnpm db:migrate` / `db:seed` / `db:studio` | Prisma |

## Rules the tooling enforces

- `app/` cannot import `src/db` or `src/services`. Services cannot import `src/db`. `src/domain` imports nothing. (`eslint-plugin-boundaries`)
- `process.env` is readable only in `src/lib/env.ts`, which is Zod-validated.
- `search.list` (100 quota units) is a lint error inside `src/services/youtube/`.
- `next start` **exits** if production configuration is incomplete. `next build` needs no secrets.
- Tests refuse to run against a database whose name does not end in `_test`.
- Every Prisma migration is generated with `--create-only` and read before it is applied.
