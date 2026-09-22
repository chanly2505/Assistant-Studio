/**
 * YouTube Analytics: date windows, provisional data, and period totals.
 * Pure — no I/O. docs/architecture/06 §6.3, 12 §C
 *
 * Facts this relies on (YouTube Analytics API documentation):
 *   - Processing latency is 48–72 hours: the most recent days are missing or
 *     incomplete, and are revised once processing finishes.
 *   - "If no data is available for the given query, the rows element will be
 *     omitted." A missing day is therefore UNKNOWN, not zero. Nothing here ever
 *     fills a gap with 0.
 */

/** Days after which a figure is treated as final. Matches the 48–72 h latency. */
export const PROVISIONAL_DAYS = 3;

/** Every sync re-fetches this many days, so revisions overwrite earlier figures. */
export const TRAILING_REFETCH_DAYS = 7;

/** First-sync history for the channel series. One request covers it all. */
export const CHANNEL_BACKFILL_DAYS = 365;

/** First-sync history for a single video's series. */
export const VIDEO_BACKFILL_DAYS = 28;

export const CHANNEL_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'subscribersGained',
  'subscribersLost',
  'likes',
  'comments',
  'shares',
] as const;

export const VIDEO_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
] as const;

/* ------------------------------ calendar days ------------------------------ */
// Days are 'YYYY-MM-DD' strings handled as UTC midnights, so arithmetic never
// crosses a daylight-saving boundary.

const DAY_MS = 86_400_000;

export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fromDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, delta: number): string {
  return toDay(new Date(fromDay(day).getTime() + delta * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((fromDay(to).getTime() - fromDay(from).getTime()) / DAY_MS);
}

export function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

export function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/* -------------------------------- windows -------------------------------- */

export interface Window {
  startDate: string;
  endDate: string;
}

/**
 * Which days to request for a channel.
 *
 *   first sync   → the last CHANNEL_BACKFILL_DAYS (not before the channel existed)
 *   later syncs  → the trailing TRAILING_REFETCH_DAYS, extended back to the last
 *                  stored day if syncs were missed, so no gap is ever left
 */
export function channelWindow(params: {
  today: string;
  lastStoredDay: string | null;
  channelCreatedDay: string | null;
}): Window {
  const { today, lastStoredDay, channelCreatedDay } = params;
  const earliest = addDays(today, -(CHANNEL_BACKFILL_DAYS - 1));

  let startDate = lastStoredDay
    ? minDay(addDays(today, -(TRAILING_REFETCH_DAYS - 1)), lastStoredDay)
    : earliest;

  startDate = maxDay(startDate, earliest);
  if (channelCreatedDay) startDate = maxDay(startDate, channelCreatedDay);
  return { startDate: minDay(startDate, today), endDate: today };
}

/** Same rule for one video, with a shorter first-sync history. */
export function videoWindow(params: {
  today: string;
  lastStoredDay: string | null;
  publishedDay: string;
}): Window {
  const { today, lastStoredDay, publishedDay } = params;
  const startDate = lastStoredDay
    ? minDay(addDays(today, -(TRAILING_REFETCH_DAYS - 1)), lastStoredDay)
    : addDays(today, -(VIDEO_BACKFILL_DAYS - 1));
  return { startDate: minDay(maxDay(startDate, publishedDay), today), endDate: today };
}

/** Still inside the processing window, so YouTube may revise it. */
export function isProvisional(day: string, fetchedOn: string): boolean {
  return daysBetween(day, fetchedOn) < PROVISIONAL_DAYS;
}

/* --------------------------------- totals --------------------------------- */

export interface DailyPoint {
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface PeriodTotals {
  views: number;
  watchHours: number;
  /** Seconds, weighted by views — NOT the mean of daily averages. */
  averageViewDurationSeconds: number | null;
  subscribersGained: number;
  subscribersLost: number;
  netSubscribers: number;
  likes: number;
  comments: number;
  shares: number;
  /** Days that actually had data; a period with gaps says so. */
  daysWithData: number;
}

/**
 * Sums a period. The average view duration is total watch time divided by total
 * views: averaging the daily averages would weight a 3-view day the same as a
 * 3,000-view day.
 */
export function totalsOf(points: DailyPoint[]): PeriodTotals {
  const sum = (pick: (point: DailyPoint) => number) =>
    points.reduce((total, point) => total + pick(point), 0);

  const views = sum((p) => p.views);
  const minutes = sum((p) => p.estimatedMinutesWatched);
  const gained = sum((p) => p.subscribersGained);
  const lost = sum((p) => p.subscribersLost);

  return {
    views,
    watchHours: minutes / 60,
    averageViewDurationSeconds: views > 0 ? Math.round((minutes * 60) / views) : null,
    subscribersGained: gained,
    subscribersLost: lost,
    netSubscribers: gained - lost,
    likes: sum((p) => p.likes),
    comments: sum((p) => p.comments),
    shares: sum((p) => p.shares),
    daysWithData: points.length,
  };
}

/**
 * Relative change, or null when there is no baseline to compare against.
 * Only for quantities that cannot be negative: a ratio against a negative
 * baseline flips sign. Use an absolute difference for net values.
 */
export function changeRatio(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/* ------------------------------ weekly buckets ------------------------------ */

export interface BucketPoint {
  day: string;
  value: number | null;
  provisional: boolean;
}

/**
 * Sums a daily series into 7-day buckets starting at the first day. A bucket
 * with no known day is null (unknown), not 0; a bucket containing any
 * provisional day is provisional. Used when daily columns would be thinner
 * than a couple of pixels (periods over 90 days).
 */
export function bucketWeekly(points: BucketPoint[]): BucketPoint[] {
  const buckets: BucketPoint[] = [];
  for (let start = 0; start < points.length; start += 7) {
    const slice = points.slice(start, start + 7);
    const known = slice.filter((point) => point.value !== null);
    buckets.push({
      day: slice[0]?.day ?? '',
      value: known.length ? known.reduce((sum, point) => sum + (point.value as number), 0) : null,
      provisional: slice.some((point) => point.provisional),
    });
  }
  return buckets;
}
