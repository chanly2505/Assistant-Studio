import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { ERROR_DEFINITIONS } from '@/domain/errors/error-code';
import { parsePreviewLocales } from '@/lib/i18n/preview-locales';
import { ALL_LOCALES, RELEASED_LOCALES } from '@/lib/i18n/routing';

/**
 * The server sends translation keys, never English prose. If a key has no entry
 * in a catalogue the user sees a raw key — so a missing key must fail CI.
 * docs/architecture/04-api-architecture.md §4.3
 *
 * Every catalogue that EXISTS is held to the same standard, released or
 * draft: a draft can be switched on for review at any time, and a broken one
 * would show raw keys or crash a page in front of the reviewer.
 */

type Messages = Record<string, unknown>;

function cataloguePath(locale: string) {
  return resolve(process.cwd(), 'messages', `${locale}.json`);
}

function loadCatalogue(locale: string): Messages {
  return JSON.parse(readFileSync(cataloguePath(locale), 'utf8')) as Messages;
}

function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];

  return Object.entries(value as Messages).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function valueAt(messages: Messages, key: string): string {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Messages)[part], messages) as string;
}

/**
 * The argument names an ICU message uses: `{name}`, `{count, plural, …}`.
 * Only top-level arguments — text inside plural branches is translated freely.
 */
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i += 1) {
    const char = message[i];
    if (char === "'") {
      // ICU quoting: '{' is a literal brace.
      const close = message.indexOf("'", i + 1);
      if (close > i + 1) i = close;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        const match = /^\{\s*([A-Za-z_][\w]*)\s*[,}]/.exec(message.slice(i));
        if (match?.[1]) names.add(match[1]);
      }
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }
  }
  return [...names].sort();
}

/** A value for every argument, of the kind ICU expects for it. */
function sampleValues(message: string): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const name of argumentsOf(message)) {
    values[name] = new RegExp(`\\{\\s*${name}\\s*,\\s*(plural|selectordinal|number)`).test(message)
      ? 2
      : 'x';
  }
  return values;
}

const english = loadCatalogue('en');
const englishKeys = flatten(english);
const englishKeySet = new Set(englishKeys);
const EXISTING = ALL_LOCALES.filter((locale) => existsSync(cataloguePath(locale)));

describe('message catalogues', () => {
  it('has a catalogue for every released locale', () => {
    for (const locale of RELEASED_LOCALES) {
      expect(EXISTING).toContain(locale);
    }
  });

  it.each(EXISTING)('%s has exactly the same key set as en', (locale) => {
    const keys = new Set(flatten(loadCatalogue(locale)));

    const missing = englishKeys.filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !englishKeySet.has(key));

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(EXISTING)('%s: every message parses and formats', (locale) => {
    const messages = loadCatalogue(locale);
    const problems: string[] = [];
    const t = createTranslator({
      locale,
      // Loaded at runtime, so not the compile-time IntlMessages type.
      messages: messages as unknown as IntlMessages,
      onError: (error) => problems.push(`${error.code}: ${error.message}`),
      getMessageFallback: ({ key }) => `!!${key}`,
    });
    for (const key of englishKeys) {
      const out = t(key as never, sampleValues(valueAt(english, key)) as never);
      if (typeof out !== 'string' || out.startsWith('!!')) problems.push(`${key} → ${String(out)}`);
    }
    expect(problems).toEqual([]);
  });

  it.each(EXISTING.filter((l) => l !== 'en'))(
    '%s uses exactly the placeholders en uses, per message',
    (locale) => {
      const messages = loadCatalogue(locale);
      const mismatched = englishKeys
        .filter(
          (key) =>
            argumentsOf(valueAt(english, key)).join() !==
            argumentsOf(valueAt(messages, key)).join(),
        )
        .map(
          (key) =>
            `${key}: en {${argumentsOf(valueAt(english, key))}} vs {${argumentsOf(valueAt(messages, key))}}`,
        );
      expect(mismatched).toEqual([]);
    },
  );

  it.each(EXISTING.filter((l) => l !== 'en'))('%s is not left in English', (locale) => {
    // A draft that silently copies English would look translated to a reviewer
    // skimming the key count. Placeholders are not words, and the product's
    // name is the same in every language.
    const SAME_EVERYWHERE = new Set(['app.name']);
    const messages = loadCatalogue(locale);
    const untouched = englishKeys.filter((key) => {
      const en = valueAt(english, key);
      const words = en.replace(/\{[^}]*\}/g, '');
      return (
        !SAME_EVERYWHERE.has(key) &&
        /[a-z]{4}/.test(words) &&
        words.trim().length > 6 &&
        valueAt(messages, key) === en
      );
    });
    expect(untouched).toEqual([]);
  });
});

describe('preview locales', () => {
  it('accepts only known, unreleased codes, once each', () => {
    expect(parsePreviewLocales(' km, TH ,xx,en,km', ALL_LOCALES, ['en'])).toEqual(['km', 'th']);
    expect(parsePreviewLocales(undefined, ALL_LOCALES, ['en'])).toEqual([]);
    expect(parsePreviewLocales('', ALL_LOCALES, ['en'])).toEqual([]);
  });

  it('argument parsing sees top-level placeholders only', () => {
    expect(argumentsOf('Hi {name}, {count, plural, one {# item} other {# items}}')).toEqual([
      'count',
      'name',
    ]);
    expect(argumentsOf("Literal '{braces}' here")).toEqual([]);
  });
});

describe('error message keys', () => {
  it('has a translation for every error code in the taxonomy', () => {
    const missing = Object.entries(ERROR_DEFINITIONS)
      .filter(([, definition]) => !englishKeySet.has(definition.messageKey))
      .map(([code, definition]) => `${code} -> ${definition.messageKey}`);

    expect(missing).toEqual([]);
  });

  it('has a translation for the keys used by module-level overrides', () => {
    // checkHealth() overrides the default key for a failed readiness probe.
    expect(englishKeySet.has('errors.serviceUnavailable')).toBe(true);
  });

  it('has a translation for every Zod issue code the boundary can emit', () => {
    for (const code of [
      'invalid_type',
      'invalid_string',
      'too_small',
      'too_big',
      'invalid_enum_value',
      'unrecognized_keys',
      'custom',
    ]) {
      expect(englishKeySet.has(`errors.validation.${code}`)).toBe(true);
    }
  });
});
