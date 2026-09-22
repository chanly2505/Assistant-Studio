/**
 * Translation keys are type-checked against en.json (global.d.ts), which
 * catches a typo'd or missing key at compile time. A few keys are only known
 * at runtime — an error code from a redirect, a status from the database —
 * and those must be checked at runtime instead: `has()` first, then render.
 *
 * This wrapper is the single, visible place where that compile-time check is
 * waived. Use it only for keys that come from data, never for literals.
 */
export interface DynamicTranslator {
  (key: string, values?: Record<string, string | number | Date>): string;
  has(key: string): boolean;
}

export function dynamicKeys(t: unknown): DynamicTranslator {
  return t as DynamicTranslator;
}
