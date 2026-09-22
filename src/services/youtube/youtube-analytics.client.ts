import 'server-only';

import type { Logger } from 'pino';
import { z } from 'zod';

import { AppError } from '@/domain/errors/app-error';
import type { SecretString } from '@/domain/shared/secret';
import { describeShape, googleRequest } from '@/services/google/http';

import { classifyYouTubeError } from './youtube-data.client';

/**
 * YouTube Analytics API v2 — youtubeAnalytics.reports.query.
 * docs/architecture/06-youtube-integration-architecture.md §6.3
 *
 * Only report shapes listed in Google's "Channel reports" documentation are
 * used:
 *   - channel time series:  dimensions=day
 *   - one video's series:   dimensions=day, filters=video==ID
 * `dimensions=day,video` is NOT used: the channel-reports list does not include
 * it, and this code does not rely on undocumented combinations.
 */

const ENDPOINT = 'https://youtubeanalytics.googleapis.com/v2/reports';

const ResultTable = z.object({
  kind: z.literal('youtubeAnalytics#resultTable').optional(),
  columnHeaders: z.array(z.object({ name: z.string(), columnType: z.string().optional() })),
  // "If no data is available for the given query, the rows element will be omitted."
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).optional(),
});

export type ReportRow = Record<string, string | number | null>;

export interface ReportQuery {
  youtubeChannelId: string;
  startDate: string;
  endDate: string;
  metrics: readonly string[];
  dimensions?: readonly string[];
  /** e.g. `video==abc123`. */
  filters?: string;
  sort?: string;
}

/**
 * Returns rows as objects keyed by COLUMN NAME, read from `columnHeaders`.
 * Position-based parsing would silently shift every value if Google added or
 * reordered a column; a missing expected column fails loudly instead.
 */
export async function queryReport(
  accessToken: SecretString,
  query: ReportQuery,
  log?: Logger,
): Promise<ReportRow[]> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    ids: `channel==${query.youtubeChannelId}`,
    startDate: query.startDate,
    endDate: query.endDate,
    metrics: query.metrics.join(','),
    ...(query.dimensions?.length ? { dimensions: query.dimensions.join(',') } : {}),
    ...(query.filters ? { filters: query.filters } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  }).toString();

  const response = await googleRequest({
    api: 'youtube_analytics',
    operation: 'reports.query',
    url: url.toString(),
    timeoutMs: 20_000,
    ...(log ? { log } : {}),
    init: { headers: { authorization: `Bearer ${accessToken.expose()}` } },
  });

  if (!response.ok) throw classifyYouTubeError(response, 'reports.query');

  const parsed = ResultTable.safeParse(response.body);
  if (!parsed.success) {
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `reports.query returned an unexpected shape ${describeShape(response.body)}`,
    });
  }

  const names = parsed.data.columnHeaders.map((header) => header.name);
  const expected = [...(query.dimensions ?? []), ...query.metrics];
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new AppError('UPSTREAM_UNAVAILABLE', {
      detail: `reports.query omitted columns: ${missing.join(',')}`,
    });
  }

  return (parsed.data.rows ?? []).map((row) =>
    Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])),
  );
}

/* ------------------------------ typed readers ------------------------------ */

export interface AnalyticsDay {
  day: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number | null;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function num(row: ReportRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Maps day-dimension rows; rows without a valid day are dropped, not guessed. */
export function toAnalyticsDays(rows: ReportRow[]): AnalyticsDay[] {
  return rows
    .filter((row) => typeof row.day === 'string' && DAY.test(row.day))
    .map((row) => ({
      day: row.day as string,
      views: Math.round(num(row, 'views')),
      estimatedMinutesWatched: Math.round(num(row, 'estimatedMinutesWatched')),
      averageViewDuration: Math.round(num(row, 'averageViewDuration')),
      averageViewPercentage:
        'averageViewPercentage' in row ? num(row, 'averageViewPercentage') : null,
      subscribersGained: Math.round(num(row, 'subscribersGained')),
      subscribersLost: Math.round(num(row, 'subscribersLost')),
      likes: Math.round(num(row, 'likes')),
      comments: Math.round(num(row, 'comments')),
      shares: Math.round(num(row, 'shares')),
    }));
}
