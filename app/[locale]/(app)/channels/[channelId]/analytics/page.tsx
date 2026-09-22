import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ColumnChart } from '@/components/charts/column-chart';
import { LineChart } from '@/components/charts/line-chart';
import { bucketWeekly } from '@/domain/youtube/analytics';
import { requireUser } from '@/lib/auth/current-user';
import { localePath } from '@/lib/i18n/paths';
import {
  PERIODS,
  getChannelAnalytics,
  type PeriodDays,
} from '@/modules/analytics/get-channel-analytics';

export const dynamic = 'force-dynamic';

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; channelId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { locale, channelId } = await params;
  const { period } = await searchParams;
  setRequestLocale(locale);

  const user = await requireUser(locale);
  const periodDays = (PERIODS as readonly number[]).includes(Number(period))
    ? (Number(period) as PeriodDays)
    : 28;

  const result = await getChannelAnalytics({ userId: user.id, channelId, periodDays });
  if (!result.ok) notFound();
  const data = result.data;

  const t = await getTranslations('analytics');
  const number = new Intl.NumberFormat(locale);
  const oneDecimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const signed = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const day = (value: string) => date.format(new Date(`${value}T00:00:00Z`));

  const ratioDelta = (ratio: number | null) =>
    ratio === null
      ? null
      : {
          up: ratio >= 0,
          text: t('change', {
            sign: ratio > 0 ? '+' : '',
            percent: percent.format(ratio),
            days: data.period.days,
          }),
        };

  const netDelta =
    data.change.netSubscribersDelta === null
      ? null
      : {
          up: data.change.netSubscribersDelta >= 0,
          text: t('changeAbsolute', {
            value: signed.format(data.change.netSubscribersDelta),
            days: data.period.days,
          }),
        };

  const tiles = [
    { key: 'views', value: number.format(data.totals.views), delta: ratioDelta(data.change.views) },
    {
      key: 'watchHours',
      value: oneDecimal.format(data.totals.watchHours),
      delta: ratioDelta(data.change.watchHours),
    },
    {
      key: 'avgDuration',
      value:
        data.totals.averageViewDurationSeconds === null
          ? '—'
          : formatDuration(data.totals.averageViewDurationSeconds),
      delta: null,
    },
    { key: 'netSubscribers', value: signed.format(data.totals.netSubscribers), delta: netDelta },
  ] as const;

  const weekly = data.period.days > 90;
  const subscriberPoints = data.series.map((point) => ({
    day: point.day,
    value: point.netSubscribers,
    provisional: point.provisional,
  }));

  const chartLabels = {
    noData: t('charts.noData'),
    provisional: t('charts.provisional'),
    tableSummary: t('charts.showTable'),
    dateColumn: t('charts.date'),
  };

  return (
    <main className="page page--wide">
      <p className="small">
        <Link href={localePath(locale, '/channels')}>← {t('back')}</Link>
      </p>
      <header className="page__header">
        <h1>
          {data.channel.title} · {t('title')}
        </h1>
        <p className="muted">
          {t('range', { from: day(data.period.from), to: day(data.period.to) })}
        </p>
      </header>

      {/* Filters: one row, above everything they scope. */}
      <nav className="segmented" aria-label={t('periodLabel')}>
        {PERIODS.map((option) => (
          <Link
            key={option}
            href={localePath(locale, `/channels/${channelId}/analytics?period=${option}`)}
            className={
              option === data.period.requestedDays ? 'segmented__item is-active' : 'segmented__item'
            }
            aria-current={option === data.period.requestedDays ? 'page' : undefined}
          >
            {t(`periods.${option}`)}
          </Link>
        ))}
      </nav>
      {data.period.limitedByPlan && (
        <p className="muted small">{t('planLimited', { days: data.period.days })}</p>
      )}

      {!data.hasAnyData ? (
        <section className="card">
          <p className="muted">{t('empty')}</p>
        </section>
      ) : (
        <>
          <p className="muted small">
            {data.dataThrough
              ? t('dataThrough', { date: day(data.dataThrough) })
              : t('noFinalData')}{' '}
            {data.totals.daysWithData < data.period.days &&
              t('gapsNote', { known: data.totals.daysWithData, total: data.period.days })}
          </p>

          <section className="kpis" aria-label={t('title')}>
            {tiles.map((tile) => (
              <div key={tile.key} className="kpi">
                <p className="kpi__label">{t(`kpi.${tile.key}`)}</p>
                <p className="kpi__value">{tile.value}</p>
                {tile.key !== 'avgDuration' &&
                  (tile.delta ? (
                    <p
                      className={
                        tile.delta.up ? 'kpi__delta kpi__delta--up' : 'kpi__delta kpi__delta--down'
                      }
                    >
                      <span aria-hidden="true">{tile.delta.up ? '▲' : '▼'}</span> {tile.delta.text}
                    </p>
                  ) : (
                    <p className="kpi__delta muted">{t('noComparison')}</p>
                  ))}
              </div>
            ))}
          </section>

          <section className="card">
            <h2>{t('charts.views')}</h2>
            <LineChart
              locale={locale}
              points={data.series.map((point) => ({
                day: point.day,
                value: point.views,
                provisional: point.provisional,
              }))}
              labels={{ ...chartLabels, title: t('charts.views'), valueColumn: t('kpi.views') }}
            />
          </section>

          <section className="card">
            <h2>{weekly ? t('charts.subscribersWeekly') : t('charts.subscribers')}</h2>
            <ColumnChart
              locale={locale}
              weekly={weekly}
              points={weekly ? bucketWeekly(subscriberPoints) : subscriberPoints}
              labels={{
                ...chartLabels,
                title: weekly ? t('charts.subscribersWeekly') : t('charts.subscribers'),
                valueColumn: t('kpi.netSubscribers'),
                weekOf: t('charts.weekOf'),
              }}
            />
          </section>

          <section className="card">
            <h2>{t('topVideos.title')}</h2>
            {data.topVideos.length === 0 ? (
              <p className="muted">{t('topVideos.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('topVideos.video')}</th>
                    <th scope="col" className="num">
                      {t('topVideos.views')}
                    </th>
                    <th scope="col" className="num">
                      {t('topVideos.watchHours')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topVideos.map((video) => (
                    <tr key={video.youtubeVideoId}>
                      <td>
                        <a
                          href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {video.title}
                        </a>
                      </td>
                      <td className="num">{number.format(video.views)}</td>
                      <td className="num">{oneDecimal.format(video.watchHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">{t('topVideos.note')}</p>
          </section>
        </>
      )}

      <p className="muted small">{t('limitations')}</p>
    </main>
  );
}
