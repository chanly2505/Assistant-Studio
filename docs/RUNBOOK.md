# Operations runbook

The procedures behind Phase 9. Each one says how it is **verified**, because a procedure nobody has
run is only a hope.

---

## 1. Launch checklist (docs/architecture/10 §10.8)

| # | Item | Status |
|---|---|---|
| 1 | Google OAuth consent screen in Production, verification approved | ❌ **Needs you**: Google Cloud Console → Google Auth Platform → publish and submit for verification (2–6 weeks) |
| 2 | YouTube API compliance audit if more than the default quota is needed | ❌ **Needs you**, and only if 10,000 units/day is not enough |
| 3 | Privacy policy and terms live, naming Google user data and Limited Use | ❌ **Needs you**: legal text for your business. The facts it must state are in §7 below |
| 4 | Production Google quota confirmed, alerting wired to the real numbers | ❌ Needs a production Google project and a monitoring service (§6) |
| 5 | Rate limits and AI spend breaker load-tested at peak | ✅ `pnpm test:e2e` (`load.spec.ts`) plus the burst test in `tests/integration/ai` |
| 6 | Backup restore rehearsed; key backup verified in a separate store | ✅ Restore rehearsed locally (§2). ❌ Production key backup is a manual step for you (§3) |
| 7 | Non-English locales reviewed, or left behind their flag | ✅ Behind `PREVIEW_LOCALES`; see `messages/README.md` |

---

## 2. Backup and restore

**Production** uses the database provider's point-in-time recovery (7-day retention, RPO ≤ 5 min,
RTO ≤ 1 h). Rehearse a restore every quarter:

1. Restore the production backup into a new, scratch database. Never restore over production.
2. Point `BACKUP_SOURCE_DB` at production and take a fingerprint backup:
   ```bash
   BACKUP_SOURCE_DB=<prod-db> pnpm db:backup
   ```
3. Check the restored copy against it:
   ```bash
   pnpm db:restore-check backups/<timestamp>
   ```
   The check needs a scratch database named `studio_assistant_restore_check`.
4. Record the date and result, then delete the backup folder, because it contains personal data.

**Locally**, rehearse the same thing in one command:

```bash
pnpm db:rehearse-restore
```

This takes a consistent snapshot of every table and rebuilds a scratch database from the project's
migrations. It then loads the rows and compares each table's row count and a checksum over every
row with the source. Any difference fails the command and names the table.

**Verified:**
- On 2026-09-22 the local database restored with 25 tables, 626 rows and identical checksums.
- A deliberately altered row in a backup made the check fail on that table.
- The first run found a real problem: a migration inserts the default plans, so a naive restore
  collides with them. The restore now empties the tables before loading.

Redis is disposable. Losing it costs a token-cache warm-up and some rate-limit precision, never data.

## 3. The encryption key

`TOKEN_ENCRYPTION_KEY` encrypts every YouTube refresh token.

- **Back it up separately from the database**, in a different place such as a password manager or
  your cloud's secret manager. **Never** store it next to a database backup: a backup holding both
  the encrypted tokens and the key defeats the encryption.
- If it is lost, nothing breaks except that every user must reconnect their channel.
- **To rotate it:**
  1. Set the new key as `TOKEN_ENCRYPTION_KEY` and raise `TOKEN_ENCRYPTION_KEY_VERSION`.
  2. Put the old key in `TOKEN_ENCRYPTION_KEY_PREVIOUS` as `<version>:<base64>`.
  3. Tokens are re-encrypted as they are used. Remove the previous key once no row uses its version.

## 4. Account export and deletion

Users do both themselves under **Settings → Your data**. The API equivalents are
`GET /api/v1/account/export` and `DELETE /api/v1/account` (with `{ "confirmEmail": "…" }`).

**Deletion order:**
1. Revoke every YouTube grant at Google. This is best effort: Google may be unreachable, and the
   local copy is destroyed regardless.
2. Wipe the text of the user's AI requests and results. The cost rows stay, because the daily spend
   breaker counts them.
3. Delete the user, which cascades to their sessions, settings, grants, channels, videos,
   statistics, analytics, ideas, projects, calendar and usage.
4. Audit rows remain, with no link to the person.

**Verified:** `tests/integration/account` checks every table afterwards. It also checks that
another user is untouched, and that deletion still completes when Google is down. Removing the
text wipe makes the test fail.

If revocation failed, the user can remove access themselves at
myaccount.google.com/permissions. The report logs how many revocations failed.

## 5. Security controls

| Control | Where | Verified by |
|---|---|---|
| Content-Security-Policy with a fresh nonce per request, no `unsafe-inline` or `unsafe-eval` in production | `middleware.ts`, `src/lib/security/csp.ts` | `tests/e2e/security.spec.ts` against a production build. With the nonce removed from the policy, 13 of 14 checks fail |
| `frame-ancestors 'none'`, `object-src 'none'`, HSTS, COOP, nosniff, referrer policy | `next.config.ts` | same spec |
| Every API route rate limited (defaults: reads 120/min, writes 60/min, per user) | `src/lib/api/with-api.ts` | `tests/api/route-matrix.test.ts` |
| Every form action rate limited (sign-in 10 per 15 min per IP) | `src/lib/api/action-guard.ts` | `tests/unit/lib/action-guard.test.ts`, which fails the build if an action skips it |
| Form and API share the AI per-minute limits | `src/modules/ai/limits.ts` | `load.spec.ts` |
| Daily AI spend cap holds under bursts | `aiGenerationRepository.createPendingWithinBudget` | burst test: 20 requests at once, room for 3 → exactly 3 run. Without the lock 13 ran; without the check all 20 ran |
| Every route in the authorisation matrix | `tests/api/route-matrix.test.ts` | a new route file fails the test until it is listed |

**Load results** (production build on a laptop, real Redis limiter):

| Burst | Result |
|---|---|
| 300 reads | exactly 120 served, 180 refused with `Retry-After`, no errors |
| 30 AI requests | exactly 10 reached the tool |
| 80 writes | exactly the route's 20 accepted |

Read latency under the burst was p50 ≈ 55 ms and p95 ≈ 120 ms.

## 6. Monitoring (needs accounts)

These need services you sign up for; nothing in the code blocks them:

- **Error tracking (Sentry):** create a project, then install `@sentry/nextjs` with
  `sendDefaultPii: false`. Reuse the redaction list in `src/lib/logger/redaction.ts` in `beforeSend`.
- **Logs:** the app writes JSON logs (pino) with a request id on every line. Send them to your
  host's log drain.
- **Uptime:** point a probe at `/api/health` (is the process up) and `/api/ready` (can it reach the
  database).
- **Alerts** to wire (§10.6):
  - YouTube quota > 80% before 18:00 Pacific
  - AI spend over its daily threshold
  - oldest queued job > 2 h
  - sync failures > 10% over 30 min
  - a spike in `REAUTH_REQUIRED`
  - 5xx > 1% over 5 min

## 7. What the privacy policy must say

These are facts about the code. Keep the policy and the code in step.

- **Sign-in** asks Google only for identity (`openid email profile`).
- **Connecting a channel** asks for read-only YouTube and YouTube Analytics access, and never
  writes to YouTube.
- **Stored:** channel and video metadata, public statistics and daily channel/video analytics.
  **Never stored:** demographics, viewer-level data or comment authors.
- **Sent to the AI provider (OpenAI)** with each request:
  - the user's own text
  - their channel description (niche, audience, voice, search words)
  - a summary: posting frequency, typical length, and best recent titles relative to their
    average

  No viewer data is sent, and requests are made with `store: false`.
- **Access tokens** are encrypted at rest (AES-256-GCM) and revoked at Google when a channel is
  disconnected or the account is deleted.
- **Export and deletion** are self-service and immediate (§4).
