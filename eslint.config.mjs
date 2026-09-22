import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      '.next*/**',
      'node_modules/**',
      'coverage/**',
      '.pgdata/**',
      'next-env.d.ts',
      'src/generated/**',
    ],
  },

  js.configs.recommended,
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  prettier,

  /* ------------------------------------------------------------------ *
   * Architectural boundaries (docs/architecture/01 §1.2)
   * A violation fails the build, not a code review.
   * ------------------------------------------------------------------ */
  {
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['app/**/*', 'src/**/*'],
      // `mode: 'full'` matches the whole file path. The default ('folder') only
      // matches a file's directory, so a file sitting directly in src/db/ was
      // left unclassified — and unclassified imports are silently allowed.
      // Caught by deliberately importing src/db/prisma.ts from app/.
      'boundaries/elements': [
        { type: 'app', pattern: 'app/**/*', mode: 'full' },
        // Listed before `lib` so it matches first. Session lookup and the
        // Auth.js adapter genuinely need the database; nothing else in lib does.
        { type: 'auth', pattern: 'src/lib/auth/**/*', mode: 'full' },
        // Presentational components (charts): pure rendering, no data access.
        { type: 'ui', pattern: 'src/components/**/*', mode: 'full' },
        { type: 'module', pattern: 'src/modules/**/*', mode: 'full' },
        { type: 'service', pattern: 'src/services/**/*', mode: 'full' },
        { type: 'db', pattern: 'src/db/**/*', mode: 'full' },
        { type: 'domain', pattern: 'src/domain/**/*', mode: 'full' },
        { type: 'lib', pattern: 'src/lib/**/*', mode: 'full' },
        { type: 'worker', pattern: 'src/worker/**/*', mode: 'full' },
      ],
    },
    rules: {
      'boundaries/no-unknown-files': 'off',
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // UI/HTTP layer: use cases + lib helpers + domain types only.
            { from: 'app', allow: ['app', 'ui', 'module', 'lib', 'auth', 'domain'] },
            // UI may render domain types; it may not fetch or reach services.
            { from: 'ui', allow: ['ui', 'domain'] },
            // Application layer: orchestrates services and repositories.
            { from: 'module', allow: ['service', 'db', 'domain', 'lib', 'module'] },
            // (Modules deliberately may NOT import `auth`: use cases receive a
            // proven userId and never read cookies themselves.)
            // Integration layer knows one external system. Never the database.
            { from: 'service', allow: ['domain', 'lib', 'service'] },
            // Data layer: Prisma + domain shapes.
            { from: 'db', allow: ['domain', 'lib', 'db'] },
            // Domain is pure: it may not import anything.
            { from: 'domain', allow: ['domain'] },
            // Shared infrastructure.
            { from: 'lib', allow: ['domain', 'lib', 'auth'] },
            // The one infrastructure element allowed to reach the database.
            { from: 'auth', allow: ['domain', 'lib', 'auth', 'db'] },
            // Worker is a peer of app: a thin entry point over use cases.
            { from: 'worker', allow: ['worker', 'module', 'lib', 'domain', 'service', 'db'] },
          ],
        },
      ],
    },
  },

  /* ------------------------------------------------------------------ *
   * Secret and quota safety rails (docs/architecture/06 §6.2, 08 §8.1)
   * ------------------------------------------------------------------ */
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    ignores: ['src/lib/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from `@/lib/env` instead. It is server-only and Zod-validated at boot.',
        },
      ],
    },
  },
  {
    files: ['src/services/youtube/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='search.list']",
          message:
            'search.list costs 100 quota units. Enumerate via the uploads playlist instead (docs/architecture/06 §6.2).',
        },
      ],
    },
  },

  /* ------------------------------------------------------------------ *
   * TypeScript conventions
   * ------------------------------------------------------------------ */
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  /* Scripts, seeds and tests are allowed to be pragmatic. */
  {
    files: ['scripts/**/*.{ts,mts}', 'prisma/**/*.ts', 'tests/**/*.ts', '*.config.{ts,mts,mjs}'],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];

export default config;
