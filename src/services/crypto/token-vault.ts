import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppError } from '@/domain/errors/app-error';
import { SecretString } from '@/domain/shared/secret';

/**
 * Encryption at rest for OAuth refresh tokens.
 * docs/architecture/08-security-architecture.md §8.2
 *
 *   stored = base64( version[1] || iv[12] || authTag[16] || ciphertext )
 *
 * AES-256-GCM with the owning row's id as additional authenticated data (AAD).
 * The AAD is what stops a database-write attacker from copying one user's token
 * blob onto another user's connection row: the blob decrypts only under the id
 * it was sealed with, and GCM's tag check fails loudly otherwise.
 *
 * The version byte enables rotation without downtime. New writes use the
 * current key; reads use whichever key the row names; `needsReEncryption`
 * tells the caller to rewrite a row sealed under an old key.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV: the GCM-recommended size.
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Keyring {
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

export class TokenVault {
  private readonly keyring: Keyring;

  constructor(keyring: Keyring) {
    const currentKey = keyring.keys.get(keyring.current);
    if (!currentKey) {
      throw new Error(`TokenVault: current key version ${keyring.current} is not in the keyring`);
    }
    for (const [version, key] of keyring.keys) {
      if (key.length !== KEY_BYTES) {
        throw new Error(`TokenVault: key version ${version} is ${key.length} bytes, expected 32`);
      }
      if (version < 1 || version > 255) {
        throw new Error(`TokenVault: key version ${version} must fit in one byte (1-255)`);
      }
    }
    this.keyring = keyring;
  }

  /** `aad` MUST be the id of the row the ciphertext will be stored on. */
  encrypt(plaintext: SecretString, aad: string): string {
    if (!aad) throw new Error('TokenVault.encrypt: aad (row id) is required');

    const version = this.keyring.current;
    const key = this.keyring.keys.get(version) as Buffer;
    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext.expose(), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([Buffer.from([version]), iv, tag, ciphertext]).toString('base64');
  }

  decrypt(stored: string, aad: string, label = 'token'): SecretString {
    const raw = Buffer.from(stored, 'base64');
    if (raw.length < 1 + IV_BYTES + TAG_BYTES + 1) {
      throw this.failure('ciphertext is truncated or not produced by TokenVault');
    }

    const version = raw[0] as number;
    const key = this.keyring.keys.get(version);
    if (!key) throw this.failure(`no key for version ${version} (was it removed too early?)`);

    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(1 + IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return new SecretString(plaintext.toString('utf8'), label);
    } catch (cause) {
      // Wrong key, wrong row (AAD mismatch) or tampering. Deliberately one
      // message: the distinction is not safe to surface.
      throw this.failure('authentication failed (tampered, wrong key, or wrong row)', cause);
    }
  }

  /** True when the row was sealed under a key other than the current one. */
  needsReEncryption(stored: string): boolean {
    const version = Buffer.from(stored, 'base64')[0];
    return version !== this.keyring.current;
  }

  private failure(detail: string, cause?: unknown): AppError {
    return new AppError('INTERNAL', {
      detail: `TokenVault: ${detail}`,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** Parses `<version>:<base64>`, the format of TOKEN_ENCRYPTION_KEY_PREVIOUS. */
export function parseVersionedKey(value: string): [number, Buffer] {
  const separator = value.indexOf(':');
  const version = Number(value.slice(0, separator));
  const key = Buffer.from(value.slice(separator + 1), 'base64');
  return [version, key];
}
