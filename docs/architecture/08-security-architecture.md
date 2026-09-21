# 8. Security Architecture

## 8.1 Secrets

| Secret | Location | Never |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | server env | in any `NEXT_PUBLIC_*`, in the client bundle |
| `OPENAI_API_KEY` | server env | in a browser request, in a log, in an error body |
| `DATABASE_URL` | server env | client, logs |
| `TOKEN_ENCRYPTION_KEY` (32-byte, base64) | secret manager | git, `.env` committed |
| `AUTH_SECRET` | server env | client |

Enforcement, mechanical rather than cultural:

1. `src/lib/env.ts` is the only module reading `process.env`. It imports `server-only`, so any
   client-side import chain fails the **build**, not a review.
2. Env is parsed by Zod at boot; a missing or malformed variable crashes startup with a clear
   message. No `process.env.X!` anywhere.
3. `NEXT_PUBLIC_*` variables are allowlisted in a lint rule; adding one requires a comment
   justifying it.
4. `gitleaks` in pre-commit and CI; `.env*` in `.gitignore` except `.env.example`, which contains
   **names only**.
5. A CI step greps the built client chunks for known secret prefixes (`sk-`, `GOCSPX-`) and fails the
   build on a hit — the last line of defence against accidental exposure.

## 8.2 Token storage

Refresh tokens are encrypted with **AES-256-GCM** before they touch the database:

```
ciphertext = AES-256-GCM(key = DEK, iv = random 96-bit, aad = connectionId)
stored     = base64(version || iv || authTag || ciphertext)
```

- `aad = connectionId` binds a ciphertext to its row: moving a blob to another connection fails
  decryption. Without AAD, a database-write attacker could swap tokens between accounts.
- `encryptionKeyVersion` enables rotation: new writes use the current key, reads try the recorded
  version, and a background job re-encrypts. Rotation needs no downtime.
- Production keys live in a managed secret store (AWS KMS / GCP Secret Manager / Vercel encrypted
  env); envelope encryption with KMS-wrapped DEKs is the upgrade path and the schema already carries
  the version column for it.
- `TokenVault.decrypt()` returns a **branded `SecretString`** whose `toString`/`toJSON`/`inspect`
  emit `[redacted]`. Logging a token accidentally is not possible; it must be explicitly unwrapped
  with `.expose()`, and `.expose()` call sites are grep-auditable and reviewed.

## 8.3 Web hardening

- **CSP** with per-request nonces, `default-src 'self'`, no `unsafe-inline`, explicit allowlist for
  YouTube thumbnail hosts (`i.ytimg.com`, `yt3.ggpht.com`), `frame-ancestors 'none'`.
- HSTS with preload, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` denying camera/microphone/geolocation.
- CSRF: `sameSite=lax` cookies plus Auth.js's built-in token; Server Actions carry framework-level
  protection. State-changing routes reject requests whose `Origin` is not the app origin.
- All output is React-escaped. **AI-generated text is rendered as text, never as HTML.** If Markdown
  rendering is added for scripts, it goes through a sanitiser with a strict allowlist — generated
  content is untrusted input.
- No user-controlled URL is ever fetched server-side (SSRF); the only outbound hosts are a fixed
  allowlist.

## 8.4 Input and output validation

- Zod at every boundary: HTTP body/query/params, OAuth callback params, **external API responses**,
  AI outputs, job payloads.
- `.strict()` on request schemas — unknown keys are rejected, not silently stripped, so a client
  sending `{ userId: "someone-else" }` fails loudly.
- Prisma parameterises everything; raw SQL is confined to the partitioning migrations and uses
  `Prisma.sql` tagged templates.
- Response shapes validated against output schemas in dev/test so internal fields cannot leak.

## 8.5 Rate limiting and abuse

| Surface | Limit |
|---|---|
| Sign-in attempts | 10 / 15 min / IP |
| OAuth start | 5 / hour / user |
| AI ideas/titles/description | 10 / min/user, plus monthly plan quota |
| AI script | 3 / min/user, plus monthly plan quota |
| Manual channel sync | 1 / hour / channel |
| Read API | 120 / min / user |
| Global | platform-wide AI spend breaker |

Redis sliding-window counters, fail-**closed** for AI routes (if Redis is down, reject rather than
allow unmetered spend) and fail-**open** for read routes (availability matters more than precision
there). That asymmetry is deliberate and documented at the call site.

## 8.6 Logging and PII

`pino` with a redaction allowlist. Forbidden in logs, enforced by a redaction config plus a unit test
that feeds a crafted object through the logger and asserts the output: `access_token`,
`refresh_token`, `id_token`, `code`, `client_secret`, `authorization`, `cookie`, `set-cookie`,
`api_key`, `email` (hashed instead), raw IP (hashed instead), full AI prompts containing user text.

Logged instead: correlation id, `userId`, route, status, duration, external API name, quota units
consumed, error code and class, payload **shape** (key names) on parse failures.

Retention: application logs 30 days, `AuditLog` 400 days, Sentry with `sendDefaultPii: false` and a
`beforeSend` scrubber.

## 8.7 Data protection & privacy

- TLS everywhere; Postgres connections require TLS; encryption at rest at the provider.
- Data minimisation: no demographics, no viewer-level data, no comment authors stored.
- **Export**: `GET /api/v1/account/export` produces a JSON archive of everything tied to the user.
- **Deletion**: revoke Google grants → purge YouTube and content data → null `userId` on audit rows.
  Completed within 30 days and audit-logged.
- Google's Limited Use requirements are reflected in the privacy policy and, more importantly, in
  the context builder (§7.5) — the policy and the code say the same thing.

## 8.8 Supply chain and CI gates

- pnpm with a committed lockfile; `pnpm audit` + Dependabot/Renovate.
- CI blocks merge on: typecheck, lint (including boundary and no-`search.list` rules), unit +
  integration tests, `gitleaks`, bundle-secret grep, and a Prisma migration-drift check.
- Production runs as a non-root container user, read-only filesystem where possible, with no shell
  in the runtime image.

## 8.9 Threat model — top risks and controls

| Threat | Control |
|---|---|
| OAuth grant injection (attacker attaches their channel to a victim account) | `state` bound to session `userId`, single-use, PKCE |
| Stolen DB dump → YouTube account access | AES-256-GCM with AAD, key in a separate secret store, rotation |
| IDOR across users | every repository query scoped by `userId`; 404-not-403; table-driven authz test suite |
| Prompt injection via channel description or user notes | delimited user content, instruction-resistant system prompt, output schema validation, injection regression suite |
| Cost exhaustion / AI abuse | pre-call allowance check, per-minute limits, token caps, global spend breaker |
| YouTube quota exhaustion (one user degrades everyone) | per-user cap + circuit breaker + tiered sync |
| Secret leakage to client | `server-only`, allowlisted `NEXT_PUBLIC_*`, CI bundle grep |
| Session theft | `httpOnly`/`secure`/`__Host-`, DB sessions with instant revocation, rotation on privilege change |
| Token exposure in logs | branded `SecretString`, redaction config, logger unit test |
