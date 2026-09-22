/**
 * Wall-clock ↔ instant conversion in a named IANA time zone, using only Intl.
 *
 * The browser sends `<input type="datetime-local">` values ("2026-10-03T18:00")
 * with no zone. They mean "18:00 where the creator lives", so the server
 * converts with the user's saved time zone — never the server's own, which is
 * UTC in production and something else on a laptop.
 */

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The wall clock in `zone` at `instant`. */
export function wallClockAt(instant: Date, zone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

/** Milliseconds `zone` is ahead of UTC at `instant`. */
function offsetAt(instant: Date, zone: string): number {
  const wall = wallClockAt(instant, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/**
 * The instant a wall-clock time in `zone` refers to.
 *
 * Two-pass: take the offset at a first guess, then re-check it at the result,
 * which settles every case except the DST edges. There, a time that does not
 * exist (the skipped spring-forward hour) resolves forward, and an ambiguous
 * time (the repeated autumn hour) resolves to the first occurrence.
 */
export function wallClockToInstant(wall: WallClock, zone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = guess - offsetAt(new Date(guess), zone);
  const second = guess - offsetAt(new Date(first), zone);
  if (first === second) return new Date(first);
  // DST edge: prefer the candidate whose wall clock reads what was asked for.
  const matches = (ms: number) => {
    const w = wallClockAt(new Date(ms), zone);
    return w.hour === wall.hour && w.minute === wall.minute && w.day === wall.day;
  };
  if (matches(Math.min(first, second))) return new Date(Math.min(first, second));
  if (matches(Math.max(first, second))) return new Date(Math.max(first, second));
  return new Date(Math.max(first, second));
}

/** "2026-10-03T18:00" in `zone` → instant, or null when malformed. */
export function parseLocalDateTime(value: string, zone: string): Date | null {
  const match = LOCAL_DATETIME.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59) return null;
  return wallClockToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, zone);
}

/** "2026-10-03" in `zone` → the instant that day starts, or null when malformed. */
export function parseLocalDate(value: string, zone: string): Date | null {
  const match = LOCAL_DATE.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d] = match.map(Number) as [number, number, number, number];
  if (!isRealDate(y, mo, d)) return null;
  return wallClockToInstant({ year: y, month: mo, day: d, hour: 0, minute: 0 }, zone);
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Instant → "YYYY-MM-DDTHH:mm" in `zone`, for a datetime-local input's value. */
export function toLocalDateTimeInput(instant: Date, zone: string): string {
  const w = wallClockAt(instant, zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** Instant → "YYYY-MM-DD", the calendar day it falls on in `zone`. */
export function localDateKey(instant: Date, zone: string): string {
  const w = wallClockAt(instant, zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** "YYYY-MM" → year and month, or null when malformed. */
export function parseMonth(value: string | undefined): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1970 || year > 2200 || month < 1 || month > 12) return null;
  return { year, month };
}

export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

export function shiftMonth(year: number, month: number, by: number) {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The instants a calendar month starts and ends at, in `zone`: [start, end). */
export function monthRange(year: number, month: number, zone: string) {
  const next = shiftMonth(year, month, 1);
  return {
    start: wallClockToInstant({ year, month, day: 1, hour: 0, minute: 0 }, zone),
    end: wallClockToInstant({ ...next, day: 1, hour: 0, minute: 0 }, zone),
  };
}

/**
 * The month as weeks of day keys, Monday first. Days outside the month are
 * null so the grid keeps its shape. Pure date arithmetic — no zone involved.
 */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Mon=0
  const cells: Array<string | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: days }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
