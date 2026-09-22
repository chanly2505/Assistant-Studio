import { fileURLToPath } from 'node:url';

import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` throws by design when bundled for the browser. Under
      // Vitest there is no browser bundle, so it resolves to a no-op.
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/helpers/setup.ts', './tests/helpers/setup-fakes.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration tests share one PostgreSQL database; running files in
    // parallel lets one suite TRUNCATE while another inserts, which deadlocks.
    // (Vitest 2's default pool is `forks`, so a `threads.singleThread` setting
    // is silently ignored — `fileParallelism` is the option that applies.)
    fileParallelism: false,
    // Integration hooks TRUNCATE ~25 tables. Under machine load one such hook
    // took 11 s and tripped the 10 s default (not reproduced in 5 reruns; no
    // lock waits observed). 30 s still fails a genuinely stuck hook.
    hookTimeout: 30_000,
    // next-auth imports `next/server` without an extension, which Node's ESM
    // loader cannot resolve outside Next.js. Letting Vite process it fixes that.
    server: { deps: { inline: ['next-auth', '@auth/core'] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/lib/i18n/request.ts'],
      thresholds: {
        // Floors, not goals. The domain layer carries the rules that break
        // quietly, so it is held highest. docs/architecture/09 §9.5
        'src/domain/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        lines: 45,
        functions: 45,
        branches: 60,
        statements: 45,
      },
    },
  },
});
