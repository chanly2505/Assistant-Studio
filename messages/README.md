# Message catalogues

One JSON file per locale. `en.json` is the source of truth; every other
catalogue must contain exactly the same key set —
`tests/unit/lib/i18n.test.ts` enforces this, so a missing key fails CI instead
of rendering a raw key to a user.

## Adding a locale

1. Copy `en.json` to `<locale>.json` and translate the **values** only.
2. Add the locale to `RELEASED_LOCALES` in `src/lib/i18n/routing.ts`.

Step 2 is deliberately separate. A catalogue can exist, be reviewed and be
iterated on while the locale stays unreachable in the UI.

## Why there is no machine-translated starter file here

Khmer, Thai, Vietnamese and Chinese are all planned, and the routing, request
pipeline and error-key plumbing already support them. What is *not* acceptable
is shipping machine output as a finished translation — the failure is invisible
to the team and obvious to the user.

A locale is released only after a native speaker reviews the catalogue.
See `docs/architecture/12-constraints-and-limitations.md` §G.

Note that UI chrome (these files) is human-translated, while AI-*generated*
content is produced directly in the target language by the model rather than
translated from English — see `docs/architecture/07-ai-architecture.md` §7.4.
