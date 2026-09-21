import { randomBytes } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { oauthStateRepository } from '@/db/repositories/oauth-state.repository';
import { quotaRepository } from '@/db/repositories/quota.repository';
import { sessionRepository } from '@/db/repositories/session.repository';
import { reserveYouTubeQuota } from '@/modules/youtube/quota-guard';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('quotaRepository.reserve — atomic', () => {
  it('admits exactly the budget under heavy concurrency', async () => {
    // Read-then-write would let several of these see "9 used" and all spend.
    const attempts = await Promise.all(
      Array.from({ length: 25 }, () =>
        quotaRepository.reserve({
          api: 'YOUTUBE_DATA',
          day: '2026-09-21',
          cost: 1,
          dailyBudget: 10,
          threshold: 10,
        }),
      ),
    );

    expect(attempts.filter((units) => units !== null)).toHaveLength(10);
    expect(await quotaRepository.unitsUsed('YOUTUBE_DATA', '2026-09-21')).toBe(10);
  });

  it('refuses a multi-unit call that would overshoot the budget', async () => {
    // Regression: with only `unitsUsed < threshold`, a 10-page call at 95/100
    // was admitted and the ledger ended at 105. Found by mutation testing.
    const day = '2026-09-21';
    await quotaRepository.reserve({
      api: 'YOUTUBE_DATA',
      day,
      cost: 95,
      dailyBudget: 100,
      threshold: 100,
    });

    const tooBig = await quotaRepository.reserve({
      api: 'YOUTUBE_DATA',
      day,
      cost: 10,
      dailyBudget: 100,
      threshold: 100,
    });
    const fits = await quotaRepository.reserve({
      api: 'YOUTUBE_DATA',
      day,
      cost: 5,
      dailyBudget: 100,
      threshold: 100,
    });

    expect(tooBig).toBeNull();
    expect(fits).toBe(100);
  });

  it('keeps separate days and separate APIs apart', async () => {
    const base = { cost: 3, dailyBudget: 100, threshold: 100 };
    await quotaRepository.reserve({ api: 'YOUTUBE_DATA', day: '2026-09-21', ...base });
    await quotaRepository.reserve({ api: 'YOUTUBE_DATA', day: '2026-09-22', ...base });
    await quotaRepository.reserve({ api: 'YOUTUBE_ANALYTICS', day: '2026-09-21', ...base });

    expect(await quotaRepository.unitsUsed('YOUTUBE_DATA', '2026-09-21')).toBe(3);
    expect(await testPrisma.apiQuotaLedger.count()).toBe(3);
  });

  it('refuses a scheduled call past the 80% threshold but admits an interactive one', async () => {
    const day = '2026-09-21';
    await quotaRepository.reserve({
      api: 'YOUTUBE_DATA',
      day,
      cost: 80,
      dailyBudget: 100,
      threshold: 100,
    });

    const scheduled = await quotaRepository.reserve({
      api: 'YOUTUBE_DATA',
      day,
      cost: 1,
      dailyBudget: 100,
      threshold: 80,
    });
    const interactive = await quotaRepository.reserve({
      api: 'YOUTUBE_DATA',
      day,
      cost: 1,
      dailyBudget: 100,
      threshold: 100,
    });

    expect(scheduled).toBeNull();
    expect(interactive).toBe(81);
  });
});

describe('reserveYouTubeQuota', () => {
  it('refuses search.list as a defect, before touching the ledger', async () => {
    await expect(reserveYouTubeQuota('search.list', 'interactive')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(await testPrisma.apiQuotaLedger.count()).toBe(0);
  });

  it('files usage under the Pacific-time day', async () => {
    // 03:00 UTC on 2 June is still 1 June in Los Angeles.
    await reserveYouTubeQuota('channels.list', 'interactive', 1, new Date('2026-06-02T03:00:00Z'));
    expect(await quotaRepository.unitsUsed('YOUTUBE_DATA', '2026-06-01')).toBe(1);
  });
});

describe('oauthStateRepository.consume', () => {
  it('returns a state once, then never again', async () => {
    const user = await createTestUser();
    await oauthStateRepository.create({ state: 's1', userId: user.id, codeVerifier: 'v' });

    expect((await oauthStateRepository.consume('s1'))?.userId).toBe(user.id);
    expect(await oauthStateRepository.consume('s1')).toBeNull();
  });

  it('purges only expired states', async () => {
    const user = await createTestUser();
    await oauthStateRepository.create({ state: 'live', userId: user.id, codeVerifier: 'v' });
    await testPrisma.oAuthState.create({
      data: {
        state: 'dead',
        userId: user.id,
        codeVerifier: 'v',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    expect(await oauthStateRepository.purgeExpired()).toBe(1);
    expect(await testPrisma.oAuthState.findUnique({ where: { state: 'live' } })).not.toBeNull();
  });
});

describe('sessionRepository.findActive', () => {
  async function sessionFor(
    overrides: { expires?: Date; status?: 'ACTIVE' | 'SUSPENDED'; deleted?: boolean } = {},
  ) {
    const user = await createTestUser();
    if (overrides.status || overrides.deleted) {
      await testPrisma.user.update({
        where: { id: user.id },
        data: {
          ...(overrides.status ? { status: overrides.status } : {}),
          ...(overrides.deleted ? { deletedAt: new Date() } : {}),
        },
      });
    }
    const token = randomBytes(24).toString('hex');
    await testPrisma.session.create({
      data: {
        sessionToken: token,
        userId: user.id,
        expires: overrides.expires ?? new Date(Date.now() + 3_600_000),
      },
    });
    return { user, token };
  }

  it('resolves a valid session to its user', async () => {
    const { user, token } = await sessionFor();
    const session = await sessionRepository.findActive(token);
    expect(session?.user).toEqual({
      id: user.id,
      email: user.email,
      locale: 'en',
      planKey: 'free',
    });
  });

  it('rejects an expired session', async () => {
    const { token } = await sessionFor({ expires: new Date(Date.now() - 1) });
    expect(await sessionRepository.findActive(token)).toBeNull();
  });

  it('rejects a suspended user on their very next request', async () => {
    const { token } = await sessionFor({ status: 'SUSPENDED' });
    expect(await sessionRepository.findActive(token)).toBeNull();
  });

  it('rejects a soft-deleted user', async () => {
    const { token } = await sessionFor({ deleted: true });
    expect(await sessionRepository.findActive(token)).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await sessionRepository.findActive('no-such-token')).toBeNull();
  });
});
