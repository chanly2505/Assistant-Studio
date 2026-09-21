# 5. Authentication & Authorization Architecture

## 5.1 The central decision: two separate grants

> "Do not assume the Google account and YouTube channel are the same concept."

They are modelled as two independent OAuth grants against the same Google identity provider.

| | **Grant A — Sign in** | **Grant B — Connect channel** |
|---|---|---|
| Purpose | identify the user | act on a YouTube channel |
| Scopes | `openid email profile` | `youtube.readonly`, `yt-analytics.readonly` |
| Managed by | Auth.js v5 Google provider | our own routes in `app/api/youtube/oauth/*` |
| Stored in | `Account` (Auth.js) | `YouTubeConnection` (encrypted refresh token) |
| Offline access | no | **yes** — `access_type=offline&prompt=consent` |
| Failure mode | user signs in again | channel shows "Reconnect", app keeps working |
| Consent screen | minimal — no scary permissions | shown only when the user asks to connect |

Why it matters beyond tidiness:

- **Conversion.** Asking for YouTube analytics access on the sign-up screen kills sign-ups. Grant B
  is requested at the moment the user chooses to connect, when the value is obvious.
- **Blast radius.** Revoking channel access must not log the user out. Losing a session must not
  drop background syncs.
- **Multi-channel.** One user, many `YouTubeConnection` rows. Google's flow binds the grant to the
  channel identity the user picks, so connecting a second channel means running Grant B again — the
  schema expects that; a single-token design cannot represent it at all.
- **Scope creep later.** Adding upload scope becomes an incremental re-consent on Grant B, with the
  old grant still valid until the new one is stored.

## 5.2 Sessions

**Database sessions, not JWT.** Auth.js `strategy: 'database'` with the Prisma adapter.

Reasons: instant revocation (delete the row — a JWT stays valid until expiry), server-side session
listing so users can sign out other devices, and no risk of stale claims after a plan or role change.
The cost is one indexed lookup per request, which is negligible next to the queries the page already
does.

Cookie: `httpOnly`, `secure`, `sameSite=lax`, `__Host-` prefix in production, and a fixed
30-day lifetime that is **not** extended on use. (Implemented in Phase 3. Rolling refresh was
dropped: extending the row without re-issuing the cookie does nothing, and a fixed lifetime bounds
how long a stolen cookie stays useful.)

## 5.3 Grant B flow in detail

```
User clicks "Connect YouTube channel"
  │
  ├─ POST /api/youtube/oauth/start          (session required, CSRF-checked)
  │    • generate state (128-bit) + PKCE code_verifier
  │    • persist OAuthState{ state, userId, codeVerifier, expiresAt: +10min }
  │    • 302 → accounts.google.com/o/oauth2/v2/auth
  │        scope=openid email youtube.readonly yt-analytics.readonly
  │        access_type=offline  prompt="consent select_account"
  │        (NOT include_granted_scopes — merging the sign-in scopes would make
  │         "disconnect channel" revoke sign-in consent too)
  │        code_challenge=S256(code_verifier)
  │
  ├─ Google consent → GET /api/youtube/oauth/callback?code&state
  │    1. load OAuthState by state → must exist, be unexpired, single-use (delete on read)
  │    2. state.userId MUST equal session user id       ← blocks grant-injection
  │    3. exchange code + code_verifier for tokens
  │    4. verify the returned scope set contains every required scope
  │         → missing any ⇒ YOUTUBE_INSUFFICIENT_SCOPE, nothing stored
  │    5. no refresh_token ⇒ OAUTH_FAILED (prompt=consent makes this a defect, not a retry case)
  │    6. reserve 1 quota unit, channels.list(mine=true) — BEFORE storing anything
  │         → no channel ⇒ YOUTUBE_NO_CHANNEL · owned by another user ⇒ CONFLICT
  │    7. ONE transaction: re-check plan limit, encrypt refresh token (AES-256-GCM, AAD = row id),
  │       upsert YouTubeConnection, create/re-attach YouTubeChannel rows, first stats snapshot,
  │       AuditLog 'youtube.connection.created|reconnected'
  │    8. any failure after step 3 ⇒ best-effort revoke of the fresh grant, nothing stored
  │    9. 303 → /[locale]/channels?connected=<n>
  │   (enqueueing the first backfill arrives with the sync worker in a later phase)
```

Hard rules:
- The **access token is never persisted**. It is fetched from the refresh token on demand and cached
  in process memory until `expires_in − 120s` (moves to Redis with the sync worker).
- The **refresh token never leaves the server**, never appears in a log line, never enters a
  response body, and is never passed to the AI service.
- `state` is single-use and bound to the session user. Without step 2 an attacker can attach their
  own channel to a victim's account.

## 5.4 Token lifecycle

```
getAccessToken(connectionId)
  ├─ cache hit → return
  ├─ miss → per-connection single-flight: concurrent callers share one refresh request.
  │          (No distributed lock needed: Google does not rotate refresh tokens for this grant,
  │          so two instances refreshing at once both succeed — at worst one extra call each.)
  │          POST oauth2.googleapis.com/token  grant_type=refresh_token
  │          ├─ 200            → cache, update lastRefreshedAt, return
  │          ├─ invalid_grant  → connection.status = REAUTH_REQUIRED
  │          │                   audit + notify user, fail with YOUTUBE_REAUTH_REQUIRED
  │          │                   (expected, not an alert — see §12A on 7-day test-mode expiry)
  │          └─ 5xx / timeout  → exponential backoff + jitter, max 3, then UPSTREAM_UNAVAILABLE
```

`REAUTH_REQUIRED` is a first-class product state: the channel card shows a Reconnect button, syncs
for that channel are paused (not retried into oblivion), and no error toast fires on unrelated pages.

**Disconnect** calls Google's token revocation endpoint, then marks the connection `REVOKED` and the
channel `disconnectedAt`. Revoking upstream is not optional — leaving a live grant behind after the
user asked to disconnect is a trust violation and a compliance problem.

## 5.5 Authorization

Single-tenant-per-user in v1; the enforcement pattern is built for teams later.

1. **Route level** — middleware protects `/[locale]/(app)/**` and `withApi({ auth: 'required' })`
   protects the API. Middleware does a cheap cookie-presence check only; real verification happens
   server-side in the handler, because middleware runs on the edge without DB access.
2. **Resource level** — *every* repository method takes a proven `userId` and includes it in the
   `WHERE` clause. There is no `findById(id)` that can return another user's row; the method simply
   does not exist.
3. **Use-case level** — `requireChannelAccess(userId, channelId)` returns the channel or
   `NOT_FOUND`, and is the only way a use case obtains a channel.
4. **Defence in depth** — an integration test suite (`tests/integration/authorization.test.ts`)
   asserts that every `/api/v1` route returns 401 anonymous and 404 for another user's resource ids.
   New routes are added to a table-driven list; a route missing from it fails a lint check.

Roles (`OWNER` today; `EDITOR`/`VIEWER` reserved) live on the future `ChannelMembership` table, so
adding collaborators is additive.

## 5.6 Account security

- Email/password is **not** offered in v1. Google is the sole identity provider, which removes
  password storage, reset flows, and credential-stuffing surface entirely. If a second provider is
  needed later, link by **verified email** only, never by unverified claim.
- `AuditLog` records sign-in, sign-out, connection created/revoked, settings changed, account
  deleted — with a **hashed** IP (salted SHA-256) rather than the raw address.
- Account deletion: soft-delete the user, revoke all Google grants, hard-delete YouTube data and
  content on a 30-day timer, null out `userId` on audit and generation rows.
