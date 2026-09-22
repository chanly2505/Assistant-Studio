'use client';

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { compact, niceScale, ticks } from './scale';
import { useWidth } from './use-width';

export interface LinePoint {
  day: string;
  /** null = no data for the day. Drawn as a gap, never as zero. */
  value: number | null;
  provisional: boolean;
}

export interface LineChartLabels {
  /** Accessible name, e.g. "Daily views". */
  title: string;
  noData: string;
  provisional: string;
  tableSummary: string;
  dateColumn: string;
  valueColumn: string;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 48 };

/**
 * Single-series time chart: 2px line over a 10% wash, recessive hairline grid,
 * one y-axis. Days without data break the line. Provisional days (YouTube may
 * still revise them) are drawn fainter.
 *
 * Crosshair + tooltip on hover; ← → keys move it when focused; the same values
 * are in the table below, so nothing is hover-only.
 */
export function LineChart({
  points,
  locale,
  labels,
  formatValue,
}: {
  points: LinePoint[];
  locale: string;
  labels: LineChartLabels;
  formatValue?: (value: number) => string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const format = useMemo(
    () => formatValue ?? ((value: number) => new Intl.NumberFormat(locale).format(value)),
    [formatValue, locale],
  );
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [locale],
  );
  const fullDate = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    [locale],
  );

  const innerWidth = width - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const maxValue = Math.max(0, ...points.map((p) => p.value ?? 0));
  const scale = niceScale(maxValue);

  const x = (index: number) =>
    PAD.left + (points.length <= 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value: number) => PAD.top + innerHeight - (value / scale.max) * innerHeight;
  const baseline = PAD.top + innerHeight;

  // Contiguous runs of known values, split again where the provisional tail
  // begins. The provisional run starts on the last final point so the line
  // does not visibly break at the boundary.
  const runs = useMemo(() => {
    const result: Array<{ indices: number[]; provisional: boolean }> = [];
    let current: { indices: number[]; provisional: boolean } | null = null;
    points.forEach((point, index) => {
      if (point.value === null) {
        current = null;
        return;
      }
      if (!current || current.provisional !== point.provisional) {
        const carry: number[] =
          current && point.provisional
            ? [current.indices[current.indices.length - 1] as number]
            : [];
        current = { indices: [...carry, index], provisional: point.provisional };
        result.push(current);
      } else {
        current.indices.push(index);
      }
    });
    return result;
  }, [points]);

  const linePath = (indices: number[]) =>
    indices.map((i, n) => `${n === 0 ? 'M' : 'L'}${x(i)},${y(points[i]?.value ?? 0)}`).join('');
  const areaPath = (indices: number[]) => {
    const first = indices[0] as number;
    const last = indices[indices.length - 1] as number;
    return `${linePath(indices)}L${x(last)},${baseline}L${x(first)},${baseline}Z`;
  };

  const nearest = (clientX: number, rectLeft: number) => {
    const localX = clientX - rectLeft - PAD.left;
    const ratio = points.length <= 1 ? 0 : localX / innerWidth;
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    setActive(nearest(event.clientX, event.currentTarget.getBoundingClientRect().left));
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    setActive((current) =>
      Math.min(points.length - 1, Math.max(0, (current ?? points.length - 1) + delta)),
    );
  };

  const activePoint = active === null ? null : points[active];
  const xLabelIndices = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (value, index, all) => all.indexOf(value) === index && value >= 0,
  );

  return (
    <div className="viz" ref={ref}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={labels.title}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        {ticks(0, scale.max, scale.step).map((tick) => (
          <g key={tick}>
            <line
              className="viz__grid"
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
            x={x(index)}
            y={HEIGHT - 8}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          >
            {points[index] ? dateFormat.format(new Date(`${points[index].day}T00:00:00Z`)) : ''}
          </text>
        ))}

        {runs.map((run, index) => (
          <g
            key={index}
            className={run.provisional ? 'viz__run viz__run--provisional' : 'viz__run'}
          >
            <path className="viz__area" d={areaPath(run.indices)} />
            {run.indices.length > 1 ? (
              <path className="viz__line" d={linePath(run.indices)} />
            ) : (
              <circle
                className="viz__dot"
                cx={x(run.indices[0] as number)}
                cy={y(points[run.indices[0] as number]?.value ?? 0)}
                r={3}
              />
            )}
          </g>
        ))}

        {activePoint && active !== null && (
          <g>
            <line
              className="viz__crosshair"
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={baseline}
            />
            {activePoint.value !== null && (
              <circle className="viz__marker" cx={x(active)} cy={y(activePoint.value)} r={4} />
            )}
          </g>
        )}
      </svg>

      {activePoint && active !== null && (
        <div
          className="viz__tooltip"
          role="status"
          style={{
            left: Math.min(Math.max(x(active), 70), width - 70),
          }}
        >
          <strong>{activePoint.value === null ? labels.noData : format(activePoint.value)}</strong>
          <span>{fullDate.format(new Date(`${activePoint.day}T00:00:00Z`))}</span>
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
                <td>{fullDate.format(new Date(`${point.day}T00:00:00Z`))}</td>
                <td>
                  {point.value === null ? labels.noData : format(point.value)}
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
