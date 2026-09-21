# 9. Testing Strategy

## 9.1 Shape

```
        ▲  e2e (Playwright)           ~20 specs   critical journeys only
       ███  api / route contract      ~80 specs   every endpoint, incl. authz matrix
     █████  integration (real PG)    ~120 specs   use cases, sync, repositories
   █████████ unit (pure)             ~300 specs   domain, mappers, schemas, quota math
```

Weight sits on integration because this product's risk is concentrated in **orchestration** — token
refresh, quota accounting, sync idempotency, usage limits — not in rendering.

## 9.2 Tooling

| Purpose | Tool |
|---|---|
| Unit + integration | Vitest |
| HTTP mocking | MSW (node) with recorded fixtures |
| DB for integration | real Postgres (Docker or a dedicated CI database) + `prisma migrate deploy` |
| Route testing | direct invocation of route handlers with constructed `Request`, plus `next-test-api-route-handler` where a full runtime is needed |
| E2E | Playwright |
| Coverage | `v8`, gates below |

**No mocking of Prisma.** A mocked ORM tests the mock. Integration tests run against a real database
inside a transaction rolled back per test, which is both faster and more honest.

## 9.3 Fixtures for external APIs

Real responses are recorded once into `tests/fixtures/youtube/*.json` and
`tests/fixtures/openai/*.json`, scrubbed of identifiers, and replayed by MSW. Fixtures include the
unhappy shapes that matter: `quotaExceeded`, `insufficientPermissions`, `invalid_grant`, a deleted
video, an empty uploads playlist, a channel with zero videos, a 429 with `Retry-After`, and a
truncated/invalid JSON model response.

A weekly CI job hits the **real** APIs with a test account and diffs the response shape against the
fixtures. Upstream schema drift is caught by a failing scheduled job rather than by users.

## 9.4 What gets tested, concretely

### Unit
- Quota cost calculation and the circuit-breaker state machine at 79/80/95/100%.
- `syncTier` classification at boundaries (day 30, day 180).
- Cursor encode/decode round-trip, including ties on the sort key.
- `AppError` → HTTP mapping for every code in the taxonomy.
- Zod schemas: accept valid, reject each invalid field, strip/reject unknown keys.
- AI output validators against malformed model responses.
- `AIContextBuilder` — asserts forbidden fields are **absent** (§7.5).
- Logger redaction — a crafted object containing every forbidden key logs none of them.
- `SecretString` never serialises its value through `JSON.stringify`, template literals, or `console.log`.
- Content status transition machine: legal transitions allowed, illegal rejected.

### Integration
- **Token refresh**: success; `invalid_grant` → `REAUTH_REQUIRED` + syncs paused; concurrent callers
  produce exactly **one** refresh request (mutex); expiring cache triggers exactly one refresh.
- **OAuth callback**: valid state; expired state; reused state; state belonging to another user
  (must reject — this is the grant-injection test); missing scopes; missing `refresh_token`.
- **Sync idempotency**: running `backfill-channel` twice produces no duplicate videos and no double
  quota charge.
- **Analytics revision**: syncing a date range twice upserts rather than duplicating; a changed value
  in the trailing window overwrites and clears `isProvisional`.
- **Delta sync** stops at the first known video and costs the expected unit count (asserted against
  the quota ledger).
- **Disconnect** revokes upstream, preserves history, and reconnect resumes from `lastAnalyticsDate`
  instead of re-backfilling.
- **AI allowance**: at limit → `AI_LIMIT_REACHED` and **no provider call is made** (asserted on the
  MSW handler); a provider timeout still records the `AIGeneration` row; a dropped SSE stream still
  finalises usage; cache hit returns without spend.
- **Repository scoping**: every repository method, given a foreign `userId`, returns empty/throws.

### API / contract
- Table-driven suite over every `/api/v1` route: anonymous → 401; other user's resource id → 404;
  invalid body → 422 with field issues; over-limit → 429 with `Retry-After`.
- A lint check fails if a route file exists that is not present in that table — new endpoints cannot
  silently skip the authz matrix.
- Error bodies never contain a stack trace, SQL, a provider message, or an English sentence where a
  `messageKey` belongs.

### E2E (Playwright)
Google's real consent screen cannot and should not be automated. A **local fake OIDC provider**
(`tests/helpers/fake-oidc`) is configured in the e2e environment; Google's HTTP endpoints are stubbed
at the network layer. Journeys covered:
1. Sign in → empty dashboard → connect channel → backfill completes → videos and analytics render.
2. Generate titles → save to a project → asset versions visible → select one.
3. Create a project from an idea → move through statuses → appears on the calendar.
4. Hit the AI limit → correct, translated error → usage page shows the reset date.
5. Channel in `REAUTH_REQUIRED` → Reconnect card shown → rest of the app still works.
6. Locale switch → UI and **error messages** both translate (catches the most common i18n gap).
7. Accessibility: `axe` scan on the main authenticated pages, keyboard-only navigation of the core flow.

## 9.5 Gates

| Gate | Threshold |
|---|---|
| `src/domain/**`, `src/modules/**` coverage | ≥ 90% lines/branches |
| `src/services/**` coverage | ≥ 80% |
| Overall | ≥ 75% |
| Flaky test | quarantined within 24h or deleted; never retried into green |

Coverage is a floor, not a goal. Review asks "what breaks if this is wrong?" — untested error paths
in the token and quota code block a merge regardless of the percentage.

## 9.6 Test data

`prisma/seed.ts` builds deterministic scenarios: a new user with no channel; a user with a small
channel (12 videos, 90 days of analytics); a user with a large channel (600 videos, tiering
exercised); a connection in `REAUTH_REQUIRED`; a user at their AI limit. The same seed powers local
development, so developers work against realistic data instead of empty screens.
