/**
 * Runs once when the Next.js server starts — before it accepts a request.
 *
 * Importing the env module is what makes configuration errors fail at *boot*.
 * Without this hook `src/lib/env.ts` is only evaluated when the first request
 * loads a route, so a misconfigured deployment would pass its health check, go
 * live, and then fail for a real user.
 *
 * Next.js compiles this file for the edge runtime as well. NEXT_RUNTIME is
 * inlined at build time, so the import below is dead-code-eliminated from the
 * edge bundle only when it sits *inside* the condition — an early `return`
 * leaves it in, and the edge bundle then fails on `node:crypto`.
 *
 * Must sit beside `app/` (the project root here) or Next.js ignores it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateConfiguration } = await import('./instrumentation.node');
    await validateConfiguration();
  }
}
