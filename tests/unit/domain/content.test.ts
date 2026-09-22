import { describe, expect, it } from 'vitest';

import {
  ASSET_MAX_CHARS,
  assetTextFromOutput,
  charCount,
  isAssetFeature,
} from '@/domain/content/assets';
import { diffLines } from '@/domain/content/diff';
import {
  BOARD_STATUSES,
  checkTransition,
  nextStatus,
  transitionEffects,
} from '@/domain/content/status';
import {
  isValidTimeZone,
  localDateKey,
  monthGrid,
  monthRange,
  parseLocalDate,
  parseLocalDateTime,
  parseMonth,
  shiftMonth,
  toLocalDateTimeInput,
} from '@/domain/content/time';
import { errorMessageKey } from '@/lib/i18n/error-key';

import { validOutputs } from '../../helpers/google';

describe('project status rules', () => {
  it('lets a creator skip or go back a stage', () => {
    expect(checkTransition('IDEA', 'EDITING', { scheduledFor: null })).toBeNull();
    expect(checkTransition('EDITING', 'SCRIPTING', { scheduledFor: null })).toBeNull();
  });

  it('refuses a move to the same status', () => {
    expect(checkTransition('FILMING', 'FILMING', { scheduledFor: null })).toBe('SAME_STATUS');
  });

  it('needs a date before SCHEDULED', () => {
    expect(checkTransition('EDITING', 'SCHEDULED', { scheduledFor: null })).toBe(
      'NEEDS_SCHEDULE_DATE',
    );
    expect(checkTransition('EDITING', 'SCHEDULED', { scheduledFor: new Date() })).toBeNull();
  });

  it('stamps publishedAt on PUBLISHED and clears it when leaving', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(transitionEffects('SCHEDULED', 'PUBLISHED', now)).toEqual({ publishedAt: now });
    expect(transitionEffects('PUBLISHED', 'EDITING', now)).toEqual({ publishedAt: null });
    expect(transitionEffects('IDEA', 'SCRIPTING', now)).toEqual({});
  });

  it('offers the next column, and none after the last or for archived', () => {
    expect(nextStatus('IDEA')).toBe('SCRIPTING');
    expect(nextStatus('PUBLISHED')).toBeNull();
    expect(nextStatus('ARCHIVED')).toBeNull();
    expect(BOARD_STATUSES).not.toContain('ARCHIVED');
  });
});

describe('time zones', () => {
  it('reads a Phnom Penh wall-clock time as UTC+7', () => {
    const instant = parseLocalDateTime('2026-10-03T18:00', 'Asia/Phnom_Penh');
    expect(instant?.toISOString()).toBe('2026-10-03T11:00:00.000Z');
    expect(toLocalDateTimeInput(instant as Date, 'Asia/Phnom_Penh')).toBe('2026-10-03T18:00');
  });

  it('follows daylight saving time in New York', () => {
    expect(parseLocalDateTime('2026-07-01T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(parseLocalDateTime('2026-12-01T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-12-01T14:00:00.000Z',
    );
  });

  it('moves a time that does not exist (spring forward) past the gap', () => {
    // 2026-03-08 02:30 never happens in New York; clocks jump 02:00 → 03:00.
    const instant = parseLocalDateTime('2026-03-08T02:30', 'America/New_York') as Date;
    expect(toLocalDateTimeInput(instant, 'America/New_York')).toBe('2026-03-08T03:30');
  });

  it('takes the first of a repeated time (fall back)', () => {
    // 2026-11-01 01:30 happens twice in New York; the first is EDT (UTC-4).
    expect(parseLocalDateTime('2026-11-01T01:30', 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('rejects malformed or impossible dates and zones', () => {
    expect(parseLocalDateTime('2026-02-30T10:00', 'UTC')).toBeNull();
    expect(parseLocalDateTime('2026-10-03 18:00', 'UTC')).toBeNull();
    expect(parseLocalDateTime('2026-10-03T24:00', 'UTC')).toBeNull();
    expect(parseLocalDate('2026-13-01', 'UTC')).toBeNull();
    expect(isValidTimeZone('Asia/Phnom_Penh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('puts an instant on the day it falls on locally, not in UTC', () => {
    // 20:00 UTC on the 3rd is 03:00 on the 4th in Phnom Penh.
    const instant = new Date('2026-10-03T20:00:00Z');
    expect(localDateKey(instant, 'UTC')).toBe('2026-10-03');
    expect(localDateKey(instant, 'Asia/Phnom_Penh')).toBe('2026-10-04');
  });

  it('bounds a month at local midnight', () => {
    const { start, end } = monthRange(2026, 10, 'Asia/Phnom_Penh');
    expect(start.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    const december = monthRange(2026, 12, 'UTC');
    expect(december.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('parses and shifts months across year ends', () => {
    expect(parseMonth('2026-10')).toEqual({ year: 2026, month: 10 });
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth(undefined)).toBeNull();
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('lays a month out Monday-first in whole weeks', () => {
    // October 2026 starts on a Thursday.
    const weeks = monthGrid(2026, 10);
    expect(weeks[0]).toEqual([
      null,
      null,
      null,
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
  });
});

describe('diffLines', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'removed', text: 'b' },
      { op: 'same', text: 'c' },
      { op: 'added', text: 'd' },
    ]);
  });

  it('reports identical text as all same', () => {
    expect(diffLines('x\ny', 'x\ny').every((line) => line.op === 'same')).toBe(true);
  });

  it('keeps every line of both sides', () => {
    const before = 'one\ntwo\nthree\nfour';
    const after = 'zero\ntwo\nthree and a half\nfour\nfive';
    const lines = diffLines(before, after);
    expect(lines.filter((l) => l.op !== 'added').map((l) => l.text)).toEqual(before.split('\n'));
    expect(lines.filter((l) => l.op !== 'removed').map((l) => l.text)).toEqual(after.split('\n'));
  });
});

describe('assets from AI output', () => {
  it('takes one title by position', () => {
    expect(assetTextFromOutput('TITLES', validOutputs.TITLES, 2)).toBe('A perfectly good title 3');
    expect(assetTextFromOutput('TITLES', validOutputs.TITLES, 9)).toBeNull();
  });

  it('lays a description out as it is pasted into YouTube', () => {
    const text = assetTextFromOutput('DESCRIPTION', {
      ...validOutputs.DESCRIPTION,
      chapters: [
        { timestamp: '0:00', label: 'Intro' },
        { timestamp: '1:30', label: 'Market' },
      ],
    });
    expect(text).toMatch(/useful\.\n\n0:00 Intro\n1:30 Market\n\n#streetfood$/);
  });

  it('writes a script without English labels', () => {
    const text = assetTextFromOutput('SCRIPT', validOutputs.SCRIPT) as string;
    expect(text.startsWith('You have walked past')).toBe(true);
    expect(text).toContain('## Setup\nAt four');
    expect(text.endsWith('Subscribe for the next market.')).toBe(true);
    expect(text).not.toMatch(/Hook|Call to action/);
  });

  it('returns null for output that no longer validates', () => {
    expect(assetTextFromOutput('TITLES', { titles: [] })).toBeNull();
    expect(assetTextFromOutput('SCRIPT', null)).toBeNull();
  });

  it('only titles, descriptions and scripts become assets', () => {
    expect(isAssetFeature('TITLES')).toBe(true);
    expect(isAssetFeature('IDEAS')).toBe(false);
    expect(isAssetFeature('PLAN')).toBe(false);
  });

  it('counts characters as people do, so Khmer titles are not cut short', () => {
    // "ភ្នំពេញ" is 7 UTF-16 code units but 3 user-perceived characters.
    expect('ភ្នំពេញ'.length).toBe(7);
    expect(charCount('ភ្នំពេញ')).toBe(3);
    expect(ASSET_MAX_CHARS.TITLE).toBe(100);
  });
});

describe('errorMessageKey', () => {
  it('accepts only well-formed errors.* keys from the query string', () => {
    expect(errorMessageKey('errors.content.needsScheduleDate')).toBe(
      'errors.content.needsScheduleDate',
    );
    expect(errorMessageKey('errors.notFound')).toBe('errors.notFound');
    expect(errorMessageKey('nav.signOut')).toBeNull();
    expect(errorMessageKey('errors.<script>')).toBeNull();
    expect(errorMessageKey(undefined)).toBeNull();
    expect(errorMessageKey(`errors.${'a'.repeat(100)}`)).toBeNull();
  });
});
