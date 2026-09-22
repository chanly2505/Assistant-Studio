import { randomBytes } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildChannelContext } from '@/modules/ai/context-builder';
import { createIdea } from '@/modules/content/ideas';
import { createProject, updateProject } from '@/modules/content/projects';
import { checklistFrom, getGettingStarted, getUsageSummary } from '@/modules/onboarding/checklist';
import {
  getChannelSettings,
  getUserSettings,
  updateChannelSettings,
  updateUserSettings,
} from '@/modules/settings/settings';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';

beforeEach(() => resetDatabase());
afterAll(() => disconnectDatabase());

async function channelFor(userId: string) {
  const id = `conn_${randomBytes(4).toString('hex')}`;
  await testPrisma.youTubeConnection.create({
    data: {
      id,
      userId,
      googleSub: `sub-${id}`,
      googleEmail: 'c@example.test',
      encryptedRefreshToken: 'x',
      scopes: [],
    },
  });
  return testPrisma.youTubeChannel.create({
    data: {
      connectionId: id,
      userId,
      youtubeChannelId: `UC_${id}`,
      title: 'Street Food PP',
      uploadsPlaylistId: `UU_${id}`,
    },
  });
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.data;
}

describe('user settings', () => {
  it('saves time zone, content language and default channel', async () => {
    const user = await createTestUser();
    const channel = await channelFor(user.id);

    unwrap(
      await updateUserSettings(user.id, {
        timezone: 'Asia/Phnom_Penh',
        contentLanguage: 'km',
        defaultChannelId: channel.id,
      }),
    );
    expect(unwrap(await getUserSettings(user.id))).toMatchObject({
      timezone: 'Asia/Phnom_Penh',
      contentLanguage: 'km',
      defaultChannelId: channel.id,
      locale: 'en',
    });

    unwrap(await updateUserSettings(user.id, { defaultChannelId: null }));
    expect(unwrap(await getUserSettings(user.id)).defaultChannelId).toBeNull();
  });

  it('new projects start in the saved content language', async () => {
    const user = await createTestUser();
    unwrap(await updateUserSettings(user.id, { contentLanguage: 'th' }));
    const { projectId } = unwrap(await createProject(user.id, { title: 'ตลาดเช้า' }));
    const project = await testPrisma.contentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.locale).toBe('th');
  });

  it('refuses a language this deployment does not serve, and a bad zone', async () => {
    const user = await createTestUser();
    // No PREVIEW_LOCALES in the test environment, so only English is served.
    expect(await updateUserSettings(user.id, { locale: 'km' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', messageKey: 'errors.settings.languageUnavailable' },
    });
    expect(await updateUserSettings(user.id, { timezone: 'Moon/Base' })).toMatchObject({
      ok: false,
      error: { messageKey: 'errors.content.badTimeZone' },
    });
    // Nothing was half-saved.
    expect(unwrap(await getUserSettings(user.id))).toMatchObject({ locale: 'en', timezone: 'UTC' });
  });

  it('refuses someone else’s channel as the default', async () => {
    const user = await createTestUser();
    const stranger = await createTestUser();
    const theirs = await channelFor(stranger.id);
    expect(await updateUserSettings(user.id, { defaultChannelId: theirs.id })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('channel settings', () => {
  it('saves what the AI reads as channel context, and clears with empty text', async () => {
    const user = await createTestUser();
    const channel = await channelFor(user.id);

    unwrap(
      await updateChannelSettings(user.id, channel.id, {
        niche: 'Street food in Phnom Penh',
        targetAudience: 'Visitors and locals',
        brandVoice: 'Warm, never pushy',
        keywords: ['street food', 'phnom penh', ''],
      }),
    );
    expect(await buildChannelContext(user.id, channel.id)).toMatchObject({
      niche: 'Street food in Phnom Penh',
      targetAudience: 'Visitors and locals',
      brandVoice: 'Warm, never pushy',
      keywords: ['street food', 'phnom penh'],
    });

    unwrap(await updateChannelSettings(user.id, channel.id, { brandVoice: '' }));
    const read = unwrap(await getChannelSettings(user.id, channel.id));
    expect(read.settings.brandVoice).toBe('');
    expect(read.settings.niche).toBe('Street food in Phnom Penh');
    expect((await buildChannelContext(user.id, channel.id)).brandVoice).toBeUndefined();
  });

  it('is invisible to other users', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const channel = await channelFor(owner.id);
    expect(await getChannelSettings(stranger.id, channel.id)).toMatchObject({ ok: false });
    expect(
      await updateChannelSettings(stranger.id, channel.id, { niche: 'hijacked' }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await testPrisma.channelSettings.count()).toBe(0);
  });
});

describe('getting started', () => {
  it('orders steps and points at the first one not done', () => {
    const none = checklistFrom({
      channels: 0,
      describedChannels: 0,
      ideasOrGenerations: 0,
      projects: 0,
      scheduledProjects: 0,
    });
    expect(none).toMatchObject({ next: 'connectChannel', completed: 0, total: 5 });
    // Skipping ahead still points back at the earliest missing step.
    const skipped = checklistFrom({
      channels: 1,
      describedChannels: 0,
      ideasOrGenerations: 3,
      projects: 1,
      scheduledProjects: 0,
    });
    expect(skipped).toMatchObject({ next: 'describeChannel', completed: 3 });
    const all = checklistFrom({
      channels: 1,
      describedChannels: 1,
      ideasOrGenerations: 1,
      projects: 1,
      scheduledProjects: 1,
    });
    expect(all).toMatchObject({ next: null, completed: 5 });
  });

  it('follows what the user has actually done', async () => {
    const user = await createTestUser();
    expect(unwrap(await getGettingStarted(user.id)).next).toBe('connectChannel');

    const channel = await channelFor(user.id);
    unwrap(await updateChannelSettings(user.id, channel.id, { niche: 'Food' }));
    unwrap(await createIdea(user.id, { title: 'Night market', keywords: [] }));
    const { projectId } = unwrap(await createProject(user.id, { title: 'Night market' }));

    let progress = unwrap(await getGettingStarted(user.id));
    expect(progress).toMatchObject({
      next: 'scheduleVideo',
      completed: 4,
      firstChannelId: channel.id,
    });

    unwrap(await updateProject(user.id, projectId, { scheduledFor: '2026-11-01T10:00' }));
    progress = unwrap(await getGettingStarted(user.id));
    expect(progress.next).toBeNull();
  });

  it('does not count a disconnected channel or a deleted project', async () => {
    const user = await createTestUser();
    const channel = await channelFor(user.id);
    await testPrisma.youTubeChannel.update({
      where: { id: channel.id },
      data: { disconnectedAt: new Date() },
    });
    const { projectId } = unwrap(await createProject(user.id, { title: 'Gone' }));
    await testPrisma.contentProject.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });

    const progress = unwrap(await getGettingStarted(user.id));
    expect(progress.steps.find((s) => s.step === 'connectChannel')?.done).toBe(false);
    expect(progress.steps.find((s) => s.step === 'startProject')?.done).toBe(false);
  });
});

describe('usage summary', () => {
  it('reports AI allowance, channels and projects against the plan', async () => {
    const user = await createTestUser();
    await channelFor(user.id);
    unwrap(await createProject(user.id, { title: 'One' }));

    const usage = unwrap(await getUsageSummary(user.id));
    expect(usage.channels).toEqual({ used: 1, limit: 1 });
    expect(usage.projects.used).toBe(1);
    expect(usage.ai?.features).toHaveLength(5);
    expect(usage.ai?.features.find((f) => f.feature === 'IDEAS')).toMatchObject({
      used: 0,
      remaining: 50,
    });
  });
});
