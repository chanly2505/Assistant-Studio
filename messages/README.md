# Message catalogues

One JSON file per locale. `en.json` is the source of truth.

## Status

| File | Language | Status | Reachable by users |
|---|---|---|---|
| `en.json` | English | Source | Yes |
| `km.json` | Khmer (ភាសាខ្មែរ) | **Draft**, machine-assisted, not reviewed | No, preview only |
| `th.json` | Thai (ไทย) | **Draft**, machine-assisted, not reviewed | No, preview only |
| `vi.json` | Vietnamese (Tiếng Việt) | **Draft**, machine-assisted, not reviewed | No, preview only |
| `zh.json` | Chinese, Simplified (中文) | **Draft**, machine-assisted, not reviewed | No, preview only |

A draft is **not** a translation, and it is never shipped as one. It exists so that a native
speaker has something concrete to correct, and so the whole pipeline (routing, dates, numbers,
plurals, error messages) can be tested in every language before launch.

See `docs/architecture/12-constraints-and-limitations.md` §G.

## What CI checks, for every catalogue that exists

`tests/unit/lib/i18n.test.ts` checks every catalogue, whether released or draft:

- **Same keys as `en.json`:** nothing missing and nothing extra, so a user never sees a raw key.
- **Every message parses and formats:** ICU syntax such as `{count, plural, …}` is valid.
- **Same placeholders as English, message by message:** `{email}`, `{date}` and so on. A renamed
  placeholder would otherwise render as a literal `{date}`.
- **Nothing silently left in English:** only the product name is exempt.

In the code, `global.d.ts` type-checks every translation key against `en.json`, so a key used in
the code but missing from the catalogue fails `pnpm typecheck`.

## Reviewing a draft

1. Start the app with the draft switched on. You need to restart after changing it:

   ```bash
   PREVIEW_LOCALES=km pnpm dev
   ```

   You can list several, for example `PREVIEW_LOCALES=km,th,vi,zh`.
2. Use the language links at the bottom of any page. Every page in a draft language shows a
   "draft" notice.
3. Correct the **values** in `<locale>.json`. Never change keys or anything inside `{ }`, and
   keep plural forms such as `{count, plural, =0 {…} other {# …}}`.
4. Run `pnpm test` to confirm the catalogue still passes.

## Releasing a language

After a native speaker has reviewed the whole file:

1. Add the locale to `RELEASED_LOCALES` in `src/lib/i18n/routing.ts`.
2. Update the table above.

This step is kept separate on purpose, so a catalogue can be reviewed and improved while the
locale stays unreachable.

## Adding a new locale

1. Add it to `ALL_LOCALES` and `LOCALE_LABELS` in `src/lib/i18n/routing.ts`.
2. Copy `en.json` to `<locale>.json` and translate the values. The tests will fail until every key
   is present, valid, and no longer in English.

UI text (these files) is translated for people by people. AI-generated content is written directly
in the target language by the model, not translated from English. See
`docs/architecture/07-ai-architecture.md` §7.4.
