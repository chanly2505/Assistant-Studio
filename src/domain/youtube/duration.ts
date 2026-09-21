/**
 * YouTube reports durations as ISO 8601 (`PT1H2M3S`, `P1DT2H`, `PT0S`).
 *
 * Returns whole seconds, or null for anything that is not a duration — callers
 * store 0 and log, rather than inventing a length.
 */
const ISO_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = ISO_DURATION.exec(value);
  // "P" and "PT" alone match the pattern but carry no components.
  if (!match || value === 'P' || value.endsWith('T')) return null;

  const [, weeks, days, hours, minutes, seconds] = match;
  const total =
    Number(weeks ?? 0) * 604_800 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);

  return Math.round(total);
}

/** YouTube's upper limit for a Short since October 2024. */
export const SHORT_FORM_MAX_SECONDS = 180;

/**
 * A LENGTH heuristic, not a YouTube fact.
 *
 * The Data API has no field that says "this is a Short". A 2-minute regular
 * upload is indistinguishable here from a 2-minute Short, so the UI must say
 * "3 min or less" rather than "Short". A duration of 0 is an upcoming or live
 * stream, not a short video.
 */
export function isShortForm(durationSeconds: number): boolean {
  return durationSeconds > 0 && durationSeconds <= SHORT_FORM_MAX_SECONDS;
}
