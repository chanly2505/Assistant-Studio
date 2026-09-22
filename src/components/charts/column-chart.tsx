'use client';

import { useMemo, useState } from 'react';

import { columnPath, compact, niceSignedScale, ticks } from './scale';
import { useWidth } from './use-width';

export interface ColumnPoint {
  /** Start day of the bucket (a day, or a week's first day). */
  day: string;
  /** null = no data. Drawn as nothing, never as a zero-height bar. */
  value: number | null;
  provisional: boolean;
}

export interface ColumnChartLabels {
  title: string;
  noData: string;
  provisional: string;
  tableSummary: string;
  dateColumn: string;
  valueColumn: string;
  /** Prefix for weekly buckets in the tooltip, e.g. "Week of". */
  weekOf?: string;
}

const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 28, left: 48 };
const MAX_BAR = 24;
const GAP = 2;

/**
 * Diverging columns around a zero baseline: gains up in the positive hue,
 * losses down in the negative hue. The sign is carried twice — direction AND
 * colour — so it never depends on colour alone. Each bar is its own hover
 * target (the full band height, not just the painted pixels).
 */
export function ColumnChart({
  points,
  locale,
  labels,
  weekly = false,
}: {
  points: ColumnPoint[];
  locale: string;
  labels: ColumnChartLabels;
  weekly?: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const number = useMemo(
    () => new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' }),
    [locale],
  );
  const fullDate = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    [locale],
  );
  const shortDate = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [locale],
  );

  const innerWidth = width - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const scale = niceSignedScale(Math.min(0, ...values), Math.max(0, ...values));

  const y = (value: number) =>
    PAD.top + ((scale.max - value) / (scale.max - scale.min)) * innerHeight;
  const zero = y(0);
  const band = innerWidth / Math.max(points.length, 1);
  const barWidth = Math.max(1, Math.min(MAX_BAR, band - GAP));
  const barX = (index: number) => PAD.left + index * band + (band - barWidth) / 2;

  const label = (point: ColumnPoint) =>
    weekly && labels.weekOf
      ? `${labels.weekOf} ${fullDate.format(new Date(`${point.day}T00:00:00Z`))}`
      : fullDate.format(new Date(`${point.day}T00:00:00Z`));

  const activePoint = active === null ? null : points[active];
  const xLabelIndices = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (value, index, all) => all.indexOf(value) === index && value >= 0,
  );

  return (
    <div className="viz" ref={ref}>
      <svg width={width} height={HEIGHT} role="img" aria-label={labels.title}>
        {ticks(scale.min, scale.max, scale.step).map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? 'viz__baseline' : 'viz__grid'}
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="viz__axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
              {compact(tick, locale)}
            </text>
          </g>
        ))}

        {xLabelIndices.map((index) => (
          <text
            key={index}
            className="viz__axis"
            x={barX(index) + barWidth / 2}
            y={HEIGHT - 8}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          >
            {points[index] ? shortDate.format(new Date(`${points[index].day}T00:00:00Z`)) : ''}
          </text>
        ))}

        {points.map((point, index) => {
          const path =
            point.value === null ? '' : columnPath(barX(index), barWidth, zero, y(point.value));
          const tone = point.value !== null && point.value < 0 ? 'negative' : 'positive';
          return (
            <g key={point.day}>
              {path && (
                <path
                  className={`viz__bar viz__bar--${tone}${point.provisional ? ' viz__bar--provisional' : ''}${
                    active === index ? ' viz__bar--active' : ''
                  }`}
                  d={path}
                />
              )}
              {/* Hit target: the whole band, not the painted bar. */}
              <rect
                className="viz__hit"
                x={PAD.left + index * band}
                y={PAD.top}
                width={band}
                height={innerHeight}
                tabIndex={0}
                aria-label={`${label(point)}: ${point.value === null ? labels.noData : number.format(point.value)}`}
                onPointerEnter={() => setActive(index)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>

      {activePoint && active !== null && (
        <div
          className="viz__tooltip"
          role="status"
          style={{ left: Math.min(Math.max(barX(active) + barWidth / 2, 70), width - 70) }}
        >
          <strong>
            {activePoint.value === null ? labels.noData : number.format(activePoint.value)}
          </strong>
          <span>{label(activePoint)}</span>
          {activePoint.provisional && <span className="viz__note">{labels.provisional}</span>}
        </div>
      )}

      <details className="viz__table">
        <summary>{labels.tableSummary}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{labels.dateColumn}</th>
              <th scope="col">{labels.valueColumn}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.day}>
                <td>{label(point)}</td>
                <td>
                  {point.value === null ? labels.noData : number.format(point.value)}
                  {point.provisional ? ` · ${labels.provisional}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
