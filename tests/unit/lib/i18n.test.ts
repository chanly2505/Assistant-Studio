import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERROR_DEFINITIONS } from '@/domain/errors/error-code';
import { RELEASED_LOCALES } from '@/lib/i18n/routing';

/**
 * The server sends translation keys, never English prose. If a key has no entry
 * in a catalogue the user sees a raw key — so a missing key must fail CI.
 * docs/architecture/04-api-architecture.md §4.3
 */

type Messages = Record<string, unknown>;

function loadCatalogue(locale: string): Messages {
  const path = resolve(process.cwd(), 'messages', `${locale}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Messages;
}

function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];

  return Object.entries(value as Messages).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

const english = loadCatalogue('en');
const englishKeys = new Set(flatten(english));

describe('message catalogues', () => {
  it('has a catalogue for every released locale', () => {
    for (const locale of RELEASED_LOCALES) {
      expect(() => loadCatalogue(locale)).not.toThrow();
    }
  });

  it.each(RELEASED_LOCALES)('%s has exactly the same key set as en', (locale) => {
    const keys = new Set(flatten(loadCatalogue(locale)));

    const missing = [...englishKeys].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !englishKeys.has(key));

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});

describe('error message keys', () => {
  it('has a translation for every error code in the taxonomy', () => {
    const missing = Object.entries(ERROR_DEFINITIONS)
      .filter(([, definition]) => !englishKeys.has(definition.messageKey))
      .map(([code, definition]) => `${code} -> ${definition.messageKey}`);

    expect(missing).toEqual([]);
  });

  it('has a translation for the keys used by module-level overrides', () => {
    // checkHealth() overrides the default key for a failed readiness probe.
    expect(englishKeys.has('errors.serviceUnavailable')).toBe(true);
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
      expect(englishKeys.has(`errors.validation.${code}`)).toBe(true);
    }
  });
});
