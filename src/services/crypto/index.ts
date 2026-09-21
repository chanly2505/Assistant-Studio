import 'server-only';

import { AppError } from '@/domain/errors/app-error';
import { env } from '@/lib/env';

import { TokenVault, parseVersionedKey } from './token-vault';

let vault: TokenVault | undefined;

/**
 * The vault built from configuration. Missing keys are a CONFIGURATION_MISSING
 * error rather than a crash, so local development without a key still boots and
 * only the channel-connect flow reports what is missing. Production cannot get
 * here without a key: src/lib/env.ts refuses to start.
 */
export function getTokenVault(): TokenVault {
  if (vault) return vault;

  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new AppError('CONFIGURATION_MISSING', {
      detail: 'TOKEN_ENCRYPTION_KEY is not set; YouTube tokens cannot be stored',
      params: { setting: 'TOKEN_ENCRYPTION_KEY' },
    });
  }

  const keys = new Map<number, Buffer>([
    [env.TOKEN_ENCRYPTION_KEY_VERSION, Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64')],
  ]);

  if (env.TOKEN_ENCRYPTION_KEY_PREVIOUS) {
    const [version, key] = parseVersionedKey(env.TOKEN_ENCRYPTION_KEY_PREVIOUS);
    if (version === env.TOKEN_ENCRYPTION_KEY_VERSION) {
      throw new Error('TOKEN_ENCRYPTION_KEY_PREVIOUS must use a different version number');
    }
    keys.set(version, key);
  }

  vault = new TokenVault({ current: env.TOKEN_ENCRYPTION_KEY_VERSION, keys });
  return vault;
}

/** Test hook. */
export function setTokenVault(next: TokenVault | undefined): void {
  vault = next;
}

export { TokenVault } from './token-vault';
