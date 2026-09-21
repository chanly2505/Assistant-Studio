/**
 * `server-only` is a build-time guard: it throws if a module reaches a client
 * bundle. There is no client bundle under Vitest, so it resolves here instead.
 * The guard still protects the real Next.js build.
 */
export {};
