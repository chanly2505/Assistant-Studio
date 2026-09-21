import { AppError, toAppError } from './app-error';

/**
 * Use cases return a Result rather than throwing for *expected* conditions
 * ("channel not found", "quota reached"). Throwing is reserved for defects.
 *
 * This keeps the failure modes of a use case visible in its type signature,
 * so the HTTP boundary cannot forget to handle one.
 *
 * docs/architecture/01-system-architecture.md §1.5
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(error: AppError): Result<T> => ({ ok: false, error });

export function isOk<T>(result: Result<T>): result is { ok: true; data: T } {
  return result.ok;
}

/** Unwraps or throws. Only for call sites that genuinely cannot proceed. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.data;
  throw result.error;
}

/** Runs a promise, converting any throw into a Result failure. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toAppError(error));
  }
}

export function map<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.data)) : result;
}
