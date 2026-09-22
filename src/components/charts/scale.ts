/**
 * Axis helpers shared by the charts. Pure functions — unit-tested.
 */

/** A "nice" axis maximum and step: 0 / 250 / 500 / 750 / 1,000, never 0 / 263 / 526. */
export function niceScale(maxValue: number, targetTicks = 4): { max: number; step: number } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { max: 1, step: 1 };

  const rough = maxValue / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const niceResidual =
    residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  const step = niceResidual * magnitude;
  return { max: Math.ceil(maxValue / step) * step, step };
}

/** Symmetric-aware scale for values that can be negative (net subscribers). */
export function niceSignedScale(
  minValue: number,
  maxValue: number,
  targetTicks = 4,
): { min: number; max: number; step: number } {
  const top = Math.max(0, maxValue);
  const bottom = Math.min(0, minValue);
  const span = top - bottom;
  const { step } = niceScale(span || 1, targetTicks);
  return {
    min: bottom < 0 ? Math.floor(bottom / step) * step : 0,
    max: top > 0 ? Math.ceil(top / step) * step : bottom < 0 ? 0 : step,
    step,
  };
}

export function ticks(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max + step / 1e6; value += step) {
    values.push(Math.round(value * 1e6) / 1e6);
  }
  return values;
}

/** Compact tick/tile labels: 1,284 · 12.9K · 4.2M. */
export function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 10_000 ? 1 : 0,
  }).format(value);
}

/**
 * Rounded data-end, square at the baseline: `r` rounds the end away from the
 * baseline only. Handles bars going up (value > 0) and down (value < 0).
 */
export function columnPath(x: number, width: number, baselineY: number, endY: number): string {
  const height = Math.abs(baselineY - endY);
  if (height < 0.5) return '';
  const r = Math.min(4, width / 2, height);
  const right = x + width;

  if (endY < baselineY) {
    // Upward bar: rounded top.
    return `M${x},${baselineY}V${endY + r}Q${x},${endY} ${x + r},${endY}H${right - r}Q${right},${endY} ${right},${endY + r}V${baselineY}Z`;
  }
  // Downward bar: rounded bottom.
  return `M${x},${baselineY}V${endY - r}Q${x},${endY} ${x + r},${endY}H${right - r}Q${right},${endY} ${right},${endY - r}V${baselineY}Z`;
}
