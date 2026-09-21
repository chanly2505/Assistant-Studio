# 4. API Architecture

## 4.1 Two entry styles, one implementation

| Entry | Used for | Notes |
|---|---|---|
| **Server Actions** | form submissions from the app UI | progressive enhancement, no client fetch code |
| **Route handlers `/api/v1/*`** | polling, streaming, anything a future mobile client needs | versioned, JSON-only |

Both are ~10-line adapters over the same use case. Logic lives in exactly one place; if an action
and a route diverge, that is a bug.

## 4.2 The boundary wrapper

Every route handler is wrapped. Nothing bypasses it.

```ts
export const POST = withApi(
  {
    auth: 'required',                    // 'required' | 'optional' | 'none'
    body: GenerateTitlesInput,           // Zod
    rateLimit: { key: 'ai:titles', points: 10, windowSec: 60 },
    audit: 'ai.titles.generate',
  },
  async ({ user, body, ctx }) => generateTitles({ userId: user.id, ...body }),
);
```

`withApi` runs, in order:

1. **Correlation id** — from `x-request-id` or generated; bound to the request logger.
2. **Authentication** — resolves the Auth.js session; `401 UNAUTHENTICATED` if missing.
3. **Rate limiting** — Redis sliding window, keyed by `userId` (authenticated) or hashed IP
   (anonymous). Emits `RateLimit-*` headers and `Retry-After` on rejection.
4. **Validation** — Zod parses body, query and path params. Failures become `422 VALIDATION_FAILED`
   with a field-keyed, i18n-safe issue list. Unknown keys are stripped, never trusted.
5. **Handler** — returns `Result<T>`.
6. **Serialisation** — `BigInt` → string, `Date` → ISO, response shape validated against an output
   schema in non-production so a leak of an internal field fails tests rather than shipping.
7. **Error mapping** — `AppError` → status + safe body. Unknown throws → log full detail + Sentry,
   return `500 INTERNAL` with only the correlation id.
8. **Audit + access log** — one structured line with duration, status, user, route, correlation id.

## 4.3 Response envelope

Success:
```json
{ "data": { }, "meta": { "requestId": "01J...", "cursor": "opaque", "hasMore": true } }
```

Error:
```json
{
  "error": {
    "code": "AI_LIMIT_REACHED",
    "messageKey": "errors.ai.limitReached",
    "params": { "resetAt": "2026-10-01T00:00:00Z" },
    "requestId": "01J...",
    "retryable": false
  }
}
```

The server sends a **translation key plus parameters**, never a rendered English sentence. The client
renders it in the user's locale. This is what makes the multi-language requirement actually hold at
the error boundary, which is where most i18n implementations quietly fail.

## 4.4 Error taxonomy

| Code | HTTP | Meaning | User-facing intent |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | no/expired session | "Please sign in again" |
| `FORBIDDEN` | 403 | resource not owned by caller | generic; never reveals existence |
| `NOT_FOUND` | 404 | absent, or not owned | deliberately indistinguishable from 403 for others' rows |
| `VALIDATION_FAILED` | 422 | Zod rejected input | field-level messages |
| `RATE_LIMITED` | 429 | too many requests | "Try again in N seconds" |
| `AI_LIMIT_REACHED` | 429 | plan quota exhausted | "You've used your N generations; resets <date>" |
| `YOUTUBE_REAUTH_REQUIRED` | 409 | refresh token invalid/revoked | "Reconnect your channel" + button |
| `YOUTUBE_INSUFFICIENT_SCOPE` | 403 | grant lacks a needed scope | re-consent prompt |
| `YOUTUBE_QUOTA_EXCEEDED` | 503 | app-level quota exhausted | "Data updates are paused; retrying automatically" |
| `UPSTREAM_UNAVAILABLE` | 502 | Google/OpenAI 5xx or timeout | "Temporarily unavailable" |
| `AI_INVALID_OUTPUT` | 502 | model output failed schema after retries | "Couldn't generate — try again" |
| `CONFLICT` | 409 | e.g. channel already connected | specific, safe message |
| `INTERNAL` | 500 | anything unexpected | correlation id only |

`NOT_FOUND` vs `FORBIDDEN`: for a row owned by someone else the API returns **404**. Returning 403
would confirm the id exists — a free enumeration oracle.

## 4.5 Endpoint map (v1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/channels` | connected channels for the session user |
| DELETE | `/api/v1/channels/:id` | disconnect (revokes grant, keeps history) |
| POST | `/api/v1/channels/:id/sync` | enqueue a manual refresh — rate-limited to 1/hour/channel |
| GET | `/api/v1/channels/:id/videos` | cursor-paginated, sortable, from Postgres |
| GET | `/api/v1/channels/:id/analytics` | `?from&to&granularity` — from Postgres |
| GET | `/api/v1/videos/:id/analytics` | per-video daily series |
| POST | `/api/v1/ai/ideas\|titles\|description\|script\|plan` | generation; `script` streams |
| GET/POST | `/api/v1/ideas` | list / save |
| PATCH/DELETE | `/api/v1/ideas/:id` | update status, archive |
| GET/POST | `/api/v1/projects` | list / create (optionally from an idea) |
| GET/PATCH/DELETE | `/api/v1/projects/:id` | detail, status transition, soft delete |
| POST | `/api/v1/projects/:id/assets` | attach or select a generated asset version |
| GET/POST/PATCH/DELETE | `/api/v1/calendar` | calendar entries |
| GET/PATCH | `/api/v1/settings` | user + channel settings |
| GET | `/api/v1/usage` | AI quota remaining, reset date, history |
| GET | `/api/health`, `/api/ready` | liveness / dependency readiness |

**Pagination is cursor-based everywhere** (opaque base64 of `(sortKey, id)`). Offset pagination
breaks under concurrent sync writes.

**Mutating routes accept `Idempotency-Key`.** For AI routes the key plus `inputHash` returns the
stored `AIGeneration` instead of paying for the model twice — this also makes retry-on-flaky-network
safe and cheap.

## 4.6 Long-running and streaming operations

- **Script generation** streams tokens over SSE. The route writes the `AIGeneration` row first
  (status `PENDING`), streams, then finalises with tokens/cost/status. A dropped connection still
  leaves an accurate usage record — otherwise users would get free generations by disconnecting.
- **Sync** is never synchronous. `POST /sync` enqueues and returns `202` with a `syncJobId`; the UI
  polls `GET /api/v1/channels/:id` for `syncStatus`, or subscribes to an SSE progress channel.

## 4.7 Contracts and typing

Zod schemas live in `src/modules/**/schema.ts` and are the single source of truth: the route
validates with them, the client infers types from them via `z.infer`, and the tests assert against
them. An OpenAPI document is generated from the same schemas (`zod-to-openapi`) so the published
contract cannot drift from the code.
