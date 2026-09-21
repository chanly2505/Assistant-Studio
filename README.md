# YouTube Studio Assistant

Helps creators plan, write and understand a YouTube channel.
Architecture and constraints: [`docs/architecture/`](docs/architecture/README.md). Read
[§12 Constraints & Limitations](docs/architecture/12-constraints-and-limitations.md) first.

**Status:** Phase 2 (foundation) is complete. Sign-in, the YouTube connection and AI are **not built yet**.
Their routes return honest `401` / `501` responses, never invented data.

## Requirements

- Node.js ≥ 20.11 (22 LTS recommended)
- pnpm 9 (`corepack enable`)
- PostgreSQL 16, from **either** the vendored binaries (`pnpm db:start`, no Docker needed) **or** `docker compose up -d`

## Setup

```bash
pnpm install
cp .env.example .env            # local values; never commit
cp .env.example .env.test       # then set NODE_ENV=test and use the *_test database
pnpm db:start                   # PostgreSQL 16 on 127.0.0.1:5433 (creates dev + test DBs)
pnpm db:migrate                 # apply migrations to the dev database
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/studio_assistant_test pnpm db:migrate:deploy
pnpm db:seed                    # plans + two development users
pnpm dev                        # http://localhost:3000
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm verify` | typecheck + lint + tests (the CI gate) |
| `pnpm test` / `test:coverage` | Vitest (real PostgreSQL, Prisma never mocked) |
| `pnpm lint` | includes architectural boundary rules |
| `pnpm format` / `format:check` | Prettier |
| `pnpm db:start` / `stop` / `status` / `nuke` | local PostgreSQL lifecycle |
| `pnpm db:migrate` / `db:seed` / `db:studio` | Prisma |

## Rules the tooling enforces

- `app/` cannot import `src/db` or `src/services`. Services cannot import `src/db`. `src/domain` imports nothing. (`eslint-plugin-boundaries`)
- `process.env` is readable only in `src/lib/env.ts`, which is Zod-validated.
- `search.list` (100 quota units) is a lint error inside `src/services/youtube/`.
- `next start` **exits** if production configuration is incomplete. `next build` needs no secrets.
- Tests refuse to run against a database whose name does not end in `_test`.
# Assistant-Studio
