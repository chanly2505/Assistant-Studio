import type en from './messages/en.json';

/**
 * Type-checks every translation key against the English catalogue, so a key
 * used in code but missing from en.json fails `pnpm typecheck` (and CI)
 * instead of rendering a raw key to a user.
 */
declare global {
  // next-intl's augmentation point is an interface, so it must be declared empty.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface IntlMessages extends Messages {}
}

type Messages = typeof en;
