import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError } from '@/domain/errors/app-error';
import { SecretString } from '@/domain/shared/secret';
import { TokenVault, parseVersionedKey } from '@/services/crypto/token-vault';

/**
 * docs/architecture/08-security-architecture.md §8.2
 */

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const vault = (current = 1, keys: Array<[number, Buffer]> = [[1, key1]]) =>
  new TokenVault({ current, keys: new Map(keys) });

const token = new SecretString('1//0gLIVE-refresh-token-value', 'refreshToken');

describe('TokenVault', () => {
  it('round-trips a token under the same row id', () => {
    const v = vault();
    const sealed = v.encrypt(token, 'conn_A');
    expect(v.decrypt(sealed, 'conn_A').expose()).toBe(token.expose());
  });

  it('never stores the token in recognisable form', () => {
    const sealed = vault().encrypt(token, 'conn_A');
    expect(sealed).not.toContain('refresh-token');
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('refresh-token');
  });

  it('uses a fresh IV every time, so equal tokens do not produce equal ciphertext', () => {
    const v = vault();
    expect(v.encrypt(token, 'conn_A')).not.toBe(v.encrypt(token, 'conn_A'));
  });

  it('refuses a ciphertext moved onto another row (AAD binding)', () => {
    // The attack: copy the victim's blob onto the attacker's connection row.
    const v = vault();
    const sealed = v.encrypt(token, 'conn_victim');
    expect(() => v.decrypt(sealed, 'conn_attacker')).toThrowError(AppError);
  });

  it('refuses a tampered ciphertext', () => {
    const v = vault();
    const raw = Buffer.from(v.encrypt(token, 'conn_A'), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 0x01;
    expect(() => v.decrypt(raw.toString('base64'), 'conn_A')).toThrowError(AppError);
  });

  it('refuses a ciphertext sealed under a key it does not hold', () => {
    const sealed = vault(1, [[1, key1]]).encrypt(token, 'conn_A');
    const impostor = vault(1, [[1, key2]]);
    expect(() => impostor.decrypt(sealed, 'conn_A')).toThrowError(AppError);
  });

  it('refuses truncated input', () => {
    expect(() => vault().decrypt('AQID', 'conn_A')).toThrowError(/truncated/);
  });

  it('does not reveal which check failed', () => {
    const v = vault();
    const sealed = v.encrypt(token, 'conn_A');
    const wrongRow = (() => {
      try {
        v.decrypt(sealed, 'conn_B');
      } catch (error) {
        return (error as AppError).detail;
      }
    })();
    expect(wrongRow).toMatch(/tampered, wrong key, or wrong row/);
  });

  it('refuses to encrypt without a row id', () => {
    expect(() => vault().encrypt(token, '')).toThrowError(/aad/);
  });

  describe('key rotation', () => {
    it('writes the current version into the ciphertext', () => {
      const sealed = vault(2, [
        [1, key1],
        [2, key2],
      ]).encrypt(token, 'conn_A');
      expect(Buffer.from(sealed, 'base64')[0]).toBe(2);
    });

    it('still decrypts rows sealed under the previous key', () => {
      const old = vault(1, [[1, key1]]).encrypt(token, 'conn_A');
      const rotated = vault(2, [
        [1, key1],
        [2, key2],
      ]);

      expect(rotated.decrypt(old, 'conn_A').expose()).toBe(token.expose());
      expect(rotated.needsReEncryption(old)).toBe(true);
      expect(rotated.needsReEncryption(rotated.encrypt(token, 'conn_A'))).toBe(false);
    });

    it('fails clearly once an old key is removed too early', () => {
      const old = vault(1, [[1, key1]]).encrypt(token, 'conn_A');
      expect(() => vault(2, [[2, key2]]).decrypt(old, 'conn_A')).toThrowError(
        /no key for version 1/,
      );
    });

    it('parses the "<version>:<base64>" rotation format', () => {
      const [version, key] = parseVersionedKey(`7:${key1.toString('base64')}`);
      expect(version).toBe(7);
      expect(key.equals(key1)).toBe(true);
    });
  });

  describe('construction', () => {
    it('rejects a key that is not 32 bytes', () => {
      expect(() => vault(1, [[1, randomBytes(16)]])).toThrowError(/expected 32/);
    });

    it('rejects a current version missing from the keyring', () => {
      expect(() => vault(3, [[1, key1]])).toThrowError(/not in the keyring/);
    });

    it('rejects a version that does not fit in the header byte', () => {
      expect(() => vault(300, [[300, key1]])).toThrowError(/one byte/);
    });
  });
});
