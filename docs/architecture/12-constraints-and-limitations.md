# 12. Constraints & Limitations

Written first on purpose. Several requested capabilities are restricted by Google, and two of them
can delay a public launch by **weeks regardless of how fast the code is written**. Design around
them now, not at launch.

---

## A. Google OAuth app verification — the critical path item

The YouTube scopes this product needs (`youtube.readonly`, `yt-analytics.readonly`) are **sensitive
scopes**. Consequences:

- While the OAuth consent screen is in **Testing** status you are capped at **100 test users**, and
  **refresh tokens expire after 7 days**. An app left in Testing will silently disconnect every
  user's channel weekly. This is the single most common cause of "it worked yesterday" bugs in
  YouTube integrations.
- Going to **Production** requires Google app verification: verified domain ownership, a public
  homepage, a hosted privacy policy that names the Google data used, and a **demo video** showing
  the consent screen and exactly how each scope is used. Review commonly takes **2–6 weeks**, longer
  with rework.
- Confirm the current scope classification in the Google Cloud console before committing to a launch
  date. If any scope is classified **restricted**, an independent security assessment (CASA) is also
  required — that is a paid, multi-week engagement.

**Mitigation, baked into the plan:** the verification submission is a Phase 3 task, not a launch
task. See [11-development-phases.md](11-development-phases.md). Until verification lands, the
product runs a closed beta under the 100-user cap, and the token-refresh service is built to treat
`invalid_grant` as a normal, expected, recoverable state.

## B. YouTube Data API quota is per **project**, not per user

Default: **10,000 units/day for the whole application**, shared by every customer.

| Call | Units | Use |
|---|---|---|
| `channels.list` | 1 | channel metadata + stats |
| `playlistItems.list` (≤50) | 1 | walk the uploads playlist |
| `videos.list` (≤50 ids) | 1 | batch video metadata + stats |
| `commentThreads.list` | 1 | comments |
| **`search.list`** | **100** | **banned in this codebase** |

`search.list` costs 100× a `playlistItems.list` that returns the same videos. It is forbidden by
lint rule and by the quota guard in the YouTube client. Enumerate a channel through
`channels.list → contentDetails.relatedPlaylists.uploads → playlistItems.list`.

With that discipline a 500-video channel costs ≈ 22 units for a full first sync and ≈ 3 units/day to
stay fresh — roughly **2,000–3,000 connected channels** before the ceiling binds. Beyond that you
must apply for a quota increase, which requires passing a **YouTube API Services compliance audit**
(a written review of your UI, branding, and data handling). Budget the same 2–6 weeks.

**Mitigation:** a hard quota ledger with a circuit breaker (Section 6), sync tiers by account
activity, and no per-page-view API calls — the UI reads Postgres, never YouTube.

## C. Metrics that do **not** exist in the public API

Do not promise these in the UI:

- **Impressions and impression click-through rate.** These are Studio-only. The public YouTube
  Analytics API does not expose them. Any "improve your CTR" feature must be reframed — the honest
  version is *title/thumbnail A/B advice from AI*, labelled as advice, not as measured CTR.
- **Exact subscriber count.** `statistics.subscriberCount` is rounded to three significant figures
  (10,500 → "10,500"; 1,234,567 → "1,230,000"). For precise movement use the Analytics API's
  `subscribersGained` / `subscribersLost` daily series and accumulate.
- **Real-time data.** YouTube Analytics is **delayed roughly 2–3 days**, and revenue metrics longer.
  Figures for recent days are revised after first publication.

**Mitigation:** every analytics sync re-fetches a **trailing 7-day window** and upserts, so revisions
are absorbed. The UI shows a "data through <date>" marker rather than implying live numbers.

## D. Scope of the grant vs. scope of the account

A Google account can own or manage several YouTube channels (brand accounts). The OAuth flow makes
the user pick **one channel identity**, and the resulting tokens act as that channel. Therefore:

- "Log in with Google" and "connect a YouTube channel" are **two different grants**, modelled as two
  different tables. Conflating them is the most common design error in this product category.
- Connecting a second channel means running the channel-connect flow a second time. The data model
  supports many `YouTubeConnection` rows per `User` and resolves duplicate channel ids.

## E. Publishing and editing YouTube content

Uploading videos or editing titles/descriptions on YouTube requires `youtube.force-ssl` / upload
scopes, which carry materially heavier review. **Out of scope for v1.** The content calendar is a
*planning* tool: it produces copy the creator pastes into Studio, and tracks status. It does not
write to YouTube. The schema leaves room (`ContentProject.publishedVideoId`) to add publishing later
without migration pain.

## F. Sending YouTube data to an AI provider

The YouTube API Services Developer Policies restrict what you may do with API data, including
constraints around using it to train machine-learning models and around passing it to third parties.
The OpenAI API does not train on API traffic by default, which helps, but this is a legal question,
not an engineering one.

**Mitigation, enforced in code:** an `AIContextBuilder` is the *only* path from YouTube data into a
prompt. It emits **aggregates and derived signals** (median view duration, posting cadence, topic
clusters, top-performing title patterns) rather than raw API payloads, drops all identifiers it does
not need, and never includes viewer-level or comment-author data. Have counsel review the exact
payload shape before public launch.

## G. AI quality in Khmer, Thai, Vietnamese and Chinese

Output quality in these languages is materially below English, especially **Khmer**. Machine-scored
fluency is not a substitute for a native reader.

**Mitigation:** the AI layer generates in the user's target language directly (not English-then-
translate, which produces stilted YouTube copy), pins a locale-specific prompt version, and every
non-English locale ships only after a native speaker reviews a sample set. UI chrome is translated
by humans; only *generated content* is model-produced. Locales stay behind a feature flag until
reviewed.

## H. Cost exposure

AI is the dominant variable cost, and script generation is by far the most expensive call. Without
limits a single user can burn a month of margin in an afternoon.

**Mitigation:** per-plan monthly quotas enforced server-side before the provider call (Redis counter
with Postgres as source of truth), per-request token caps, a cheaper model for ideas/titles and the
stronger model only for scripts and plans, response caching keyed by a hash of the normalised input,
and a global daily spend circuit breaker.

## I. Local machine prerequisites (blocks Phase 2)

This machine currently has **git only**. Before implementation begins, install:

- **Node.js 20 LTS or 22 LTS** (nothing found on `PATH`)
- **pnpm** (via corepack)
- **Docker Desktop** — needed for local Postgres and Redis, and for integration tests
- Optionally `psql` for direct DB inspection

Alternative if Docker is unwanted: a hosted Postgres (Neon) and Redis (Upstash) free tier for local
development, at the cost of slower integration tests and a network dependency in CI.
