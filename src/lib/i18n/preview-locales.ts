/**
 * Which DRAFT locales are reachable, from the public `PREVIEW_LOCALES` flag
 * (inlined by next.config.ts). Draft catalogues are machine-assisted and not
 * yet reviewed by a native speaker, so they stay unreachable unless a
 * reviewer's environment turns them on. docs/architecture/12 §G
 *
 * This is the one module besides src/lib/env.ts allowed to read process.env:
 * the middleware runs on the edge and cannot import the server-only env
 * module, and this value is public and non-secret by design.
 */
export function parsePreviewLocales(
  raw: string | undefined,
  known: readonly string[],
  released: readonly string[],
): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((code) => code.trim().toLowerCase())
        .filter((code) => known.includes(code) && !released.includes(code)),
    ),
  ];
}

export const PREVIEW_LOCALES_RAW = process.env.NEXT_PUBLIC_PREVIEW_LOCALES ?? '';
