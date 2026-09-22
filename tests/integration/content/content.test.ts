import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { saveIdea } from '@/modules/ai/history';
import { addAsset, compareAssets, selectAsset } from '@/modules/content/assets';
import {
  createCalendarEntry,
  deleteCalendarEntry,
  getCalendarMonth,
  setTimeZone,
  updateCalendarEntry,
} from '@/modules/content/calendar';
import { createIdea, deleteIdea, listIdeas, setIdeaStatus } from '@/modules/content/ideas';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  promoteIdea,
  statusBeforeArchive,
  updateProject,
} from '@/modules/content/projects';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../../helpers/db';
import { validOutputs } from '../../helpers/google';

beforeEach(() => resetDatabase());
afterAll(() => disconnectDatabase());

/** A stored AI generation, as the Studio pipeline leaves it. */
async function generation(
  userId: string,
  feature: keyof typeof validOutputs,
  overrides: { status?: 'OK' | 'INVALID_OUTPUT'; locale?: string } = {},
) {
  return testPrisma.aIGeneration.create({
    data: {
      userId,
      feature,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      promptVersion: 'test.v1',
      locale: overrides.locale ?? 'en',
      inputHash: `hash-${Math.random()}`,
      status: overrides.status ?? 'OK',
      outputJson: overrides.status === 'INVALID_OUTPUT' ? undefined : validOutputs[feature],
    },
  });
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.data;
}

async function newProject(userId: string, title = 'Morning market') {
  return unwrap(await createProject(userId, { title })).projectId;
}

describe('idea → project', () => {
  it('turns a saved AI idea into a project with provenance and a first title', async () => {
    const user = await createTestUser();
    const ideas = await generation(user.id, 'IDEAS', { locale: 'km' });
    const { ideaId } = unwrap(
      await saveIdea({ userId: user.id, generationId: ideas.id, index: 1 }),
    );

    const { projectId, created } = unwrap(await promoteIdea(user.id, ideaId));
    expect(created).toBe(true);

    const project = unwrap(await getProject(user.id, projectId));
    expect(project).toMatchObject({ title: 'Idea number 2', status: 'IDEA', locale: 'km' });
    expect(project.notes).toContain('Follow a vendor');
    expect(project.assets).toEqual([
      expect.objectContaining({
        kind: 'TITLE',
        body: 'Idea number 2',
        version: 1,
        isSelected: true,
        createdBy: 'AI',
        aiGenerationId: ideas.id,
        locale: 'km',
      }),
    ]);
    expect(project.statusEvents).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'IDEA' }),
    ]);
    const idea = await testPrisma.contentIdea.findUniqueOrThrow({ where: { id: ideaId } });
    expect(idea).toMatchObject({ status: 'PROMOTED', projectId });
  });

  it('is idempotent, even with six simultaneous clicks', async () => {
    const user = await createTestUser();
    const { ideaId } = unwrap(await createIdea(user.id, { title: 'Night market', keywords: [] }));

    const results = (
      await Promise.all(Array.from({ length: 6 }, () => promoteIdea(user.id, ideaId)))
    ).map(unwrap);
    expect(new Set(results.map((r) => r.projectId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await testPrisma.contentProject.count()).toBe(1);
  });

  it('keeps promoted ideas: no archive, no delete', async () => {
    const user = await createTestUser();
    const { ideaId } = unwrap(await createIdea(user.id, { title: 'Keep me', keywords: [] }));
    unwrap(await promoteIdea(user.id, ideaId));

    expect(await setIdeaStatus(user.id, ideaId, 'ARCHIVED')).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', messageKey: 'errors.content.ideaPromoted' },
    });
    expect(await deleteIdea(user.id, ideaId)).toMatchObject({ ok: false });
  });

  it('archives, restores and deletes an unpromoted idea', async () => {
    const user = await createTestUser();
    const { ideaId } = unwrap(
      await createIdea(user.id, { title: 'Maybe later', keywords: ['a', 'b'] }),
    );
    unwrap(await setIdeaStatus(user.id, ideaId, 'ARCHIVED'));
    expect(unwrap(await listIdeas(user.id, 'ARCHIVED')).ideas).toHaveLength(1);
    unwrap(await setIdeaStatus(user.id, ideaId, 'SAVED'));
    unwrap(await deleteIdea(user.id, ideaId));
    expect(await testPrisma.contentIdea.count()).toBe(0);
  });
});

describe('versioned assets', () => {
  it('numbers versions per kind, selects the first, and keeps the rest', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);

    const v1 = unwrap(await addAsset(user.id, projectId, { kind: 'SCRIPT', body: 'Draft one' }));
    const v2 = unwrap(await addAsset(user.id, projectId, { kind: 'SCRIPT', body: 'Draft two' }));
    const t1 = unwrap(await addAsset(user.id, projectId, { kind: 'TITLE', body: 'A title' }));

    expect([v1.version, v1.isSelected]).toEqual([1, true]);
    expect([v2.version, v2.isSelected]).toEqual([2, false]);
    expect([t1.version, t1.isSelected]).toEqual([1, true]);
  });

  it('never hands out the same version number twice under concurrency', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        addAsset(user.id, projectId, { kind: 'DESCRIPTION', body: `Take ${i}` }),
      ),
    );
    const versions = results.map((r) => unwrap(r).version).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await testPrisma.contentAsset.count({ where: { projectId, isSelected: true } })).toBe(1);
  });

  it('leaves exactly one selected even when two selections race', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);
    const ids = [];
    for (const body of ['one', 'two', 'three']) {
      ids.push(unwrap(await addAsset(user.id, projectId, { kind: 'TITLE', body })).assetId);
    }

    await Promise.all([
      selectAsset(user.id, projectId, ids[1] as string),
      selectAsset(user.id, projectId, ids[2] as string),
    ]);
    const selected = await testPrisma.contentAsset.findMany({
      where: { projectId, kind: 'TITLE', isSelected: true },
    });
    expect(selected).toHaveLength(1);
  });

  it('takes AI text from the stored output, once per pick', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);
    const titles = await generation(user.id, 'TITLES');

    const added = unwrap(await addAsset(user.id, projectId, { generationId: titles.id, pick: 3 }));
    const again = unwrap(await addAsset(user.id, projectId, { generationId: titles.id, pick: 3 }));
    expect(again).toMatchObject({ assetId: added.assetId, alreadyAdded: true });

    const asset = await testPrisma.contentAsset.findUniqueOrThrow({ where: { id: added.assetId } });
    expect(asset).toMatchObject({
      kind: 'TITLE',
      body: 'A perfectly good title 4',
      createdBy: 'AI',
      aiGenerationId: titles.id,
    });
    const linked = await testPrisma.aIGeneration.findUniqueOrThrow({ where: { id: titles.id } });
    expect(linked.projectId).toBe(projectId);
  });

  it('refuses failed generations, non-asset features and other users’ results', async () => {
    const user = await createTestUser();
    const stranger = await createTestUser();
    const projectId = await newProject(user.id);

    const failed = await generation(user.id, 'SCRIPT', { status: 'INVALID_OUTPUT' });
    expect(await addAsset(user.id, projectId, { generationId: failed.id, pick: 0 })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    const plan = await generation(user.id, 'PLAN');
    expect(await addAsset(user.id, projectId, { generationId: plan.id, pick: 0 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    const theirs = await generation(stranger.id, 'TITLES');
    expect(await addAsset(user.id, projectId, { generationId: theirs.id, pick: 0 })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('enforces YouTube’s title length, counting characters as people do', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);
    // 100 Khmer clusters is 100 characters to YouTube, but ~230 UTF-16 units.
    const khmer = 'ភ្នំ'.repeat(100);
    expect(unwrap(await addAsset(user.id, projectId, { kind: 'TITLE', body: khmer })).version).toBe(
      1,
    );
    expect(
      await addAsset(user.id, projectId, { kind: 'TITLE', body: 'x'.repeat(101) }),
    ).toMatchObject({ ok: false, error: { messageKey: 'errors.content.assetTooLong' } });
  });

  it('compares two versions of the same kind only', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);
    const a = unwrap(await addAsset(user.id, projectId, { kind: 'SCRIPT', body: 'a\nb' })).assetId;
    const b = unwrap(await addAsset(user.id, projectId, { kind: 'SCRIPT', body: 'a\nc' })).assetId;
    const title = unwrap(await addAsset(user.id, projectId, { kind: 'TITLE', body: 'T' })).assetId;

    const compared = unwrap(await compareAssets(user.id, projectId, a, b));
    expect(compared.lines.map((l) => l.op)).toEqual(['same', 'removed', 'added']);
    expect(await compareAssets(user.id, projectId, a, title)).toMatchObject({ ok: false });
  });
});

describe('status workflow', () => {
  it('records every move, with notes, in order', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);

    unwrap(await updateProject(user.id, projectId, { status: 'SCRIPTING' }));
    unwrap(
      await updateProject(user.id, projectId, { status: 'EDITING', statusNote: 'Skipped filming' }),
    );

    const project = unwrap(await getProject(user.id, projectId));
    expect(project.statusEvents.map((e) => [e.fromStatus, e.toStatus, e.note])).toEqual([
      ['SCRIPTING', 'EDITING', 'Skipped filming'],
      ['IDEA', 'SCRIPTING', null],
      [null, 'IDEA', null],
    ]);
    expect(
      await testPrisma.auditLog.count({ where: { action: 'content.project.status_changed' } }),
    ).toBe(2);
  });

  it('schedules only with a date, in the user’s time zone, in one request', async () => {
    const user = await createTestUser();
    unwrap(await setTimeZone(user.id, 'Asia/Phnom_Penh'));
    const projectId = await newProject(user.id);

    expect(await updateProject(user.id, projectId, { status: 'SCHEDULED' })).toMatchObject({
      ok: false,
      error: { messageKey: 'errors.content.needsScheduleDate' },
    });

    unwrap(
      await updateProject(user.id, projectId, {
        scheduledFor: '2026-10-03T18:00',
        status: 'SCHEDULED',
      }),
    );
    const project = await testPrisma.contentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe('SCHEDULED');
    expect(project.scheduledFor?.toISOString()).toBe('2026-10-03T11:00:00.000Z');

    // The date cannot be removed while the project is scheduled.
    expect(await updateProject(user.id, projectId, { scheduledFor: '' })).toMatchObject({
      ok: false,
    });
  });

  it('stamps publishedAt on publish and clears it when moved back', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);
    const now = new Date('2026-10-05T08:00:00Z');

    unwrap(await updateProject(user.id, projectId, { status: 'PUBLISHED' }, now));
    let project = await testPrisma.contentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.publishedAt?.toISOString()).toBe(now.toISOString());

    unwrap(await updateProject(user.id, projectId, { status: 'EDITING' }));
    project = await testPrisma.contentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.publishedAt).toBeNull();
  });

  it('archives off the board and restores to the previous status', async () => {
    const user = await createTestUser();
    const projectId = await newProject(user.id);
    unwrap(await updateProject(user.id, projectId, { status: 'FILMING' }));
    unwrap(await updateProject(user.id, projectId, { status: 'ARCHIVED' }));

    const board = unwrap(await listProjects(user.id));
    expect(board.projects).toHaveLength(0);
    expect(board.archivedCount).toBe(1);

    const project = unwrap(await getProject(user.id, projectId));
    expect(statusBeforeArchive(project.statusEvents)).toBe('FILMING');
  });

  it('soft-deletes: hidden everywhere, ideas return to the list', async () => {
    const user = await createTestUser();
    const { ideaId } = unwrap(await createIdea(user.id, { title: 'Comes back', keywords: [] }));
    const { projectId } = unwrap(await promoteIdea(user.id, ideaId));
    unwrap(await updateProject(user.id, projectId, { scheduledFor: '2026-10-10T10:00' }));

    unwrap(await deleteProject(user.id, projectId));

    expect(await getProject(user.id, projectId)).toMatchObject({ ok: false });
    expect(unwrap(await listProjects(user.id)).projects).toHaveLength(0);
    expect(unwrap(await getCalendarMonth(user.id, 2026, 10)).items).toHaveLength(0);
    const idea = await testPrisma.contentIdea.findUniqueOrThrow({ where: { id: ideaId } });
    expect(idea).toMatchObject({ status: 'SAVED', projectId: null });
    // The row is kept for the audit trail.
    expect(await testPrisma.contentProject.count()).toBe(1);
  });
});

describe('calendar', () => {
  it('shows scheduled projects and entries on their LOCAL day', async () => {
    const user = await createTestUser();
    unwrap(await setTimeZone(user.id, 'Asia/Phnom_Penh'));
    const projectId = await newProject(user.id, 'Launch video');
    unwrap(await updateProject(user.id, projectId, { scheduledFor: '2026-10-31T23:30' }));
    unwrap(
      await createCalendarEntry(user.id, {
        title: 'Buy mic',
        entryType: 'TASK',
        startsAt: '2026-10-01',
      }),
    );
    // Just outside October in Phnom Penh, though still October in UTC.
    unwrap(
      await createCalendarEntry(user.id, {
        title: 'November thing',
        entryType: 'NOTE',
        startsAt: '2026-11-01T02:00',
      }),
    );

    const october = unwrap(await getCalendarMonth(user.id, 2026, 10));
    expect(october.zone).toBe('Asia/Phnom_Penh');
    expect(october.items.map((i) => [i.type, i.title, i.dayKey])).toEqual([
      ['entry', 'Buy mic', '2026-10-01'],
      ['project', 'Launch video', '2026-10-31'],
    ]);
    const allDay = october.items[0];
    expect(allDay?.type === 'entry' && allDay.allDay).toBe(true);
  });

  it('marks done, deletes, and refuses another user’s entries', async () => {
    const user = await createTestUser();
    const stranger = await createTestUser();
    const { entryId } = unwrap(
      await createCalendarEntry(user.id, {
        title: 'Film B-roll',
        entryType: 'TASK',
        startsAt: '2026-10-02T09:00',
      }),
    );

    unwrap(await updateCalendarEntry(user.id, entryId, { status: 'DONE' }));
    expect(await updateCalendarEntry(stranger.id, entryId, { status: 'CANCELLED' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await deleteCalendarEntry(stranger.id, entryId)).toMatchObject({ ok: false });
    unwrap(await deleteCalendarEntry(user.id, entryId));
    expect(await testPrisma.calendarEntry.count()).toBe(0);
  });

  it('rejects an entry linked to someone else’s project, and an unknown zone', async () => {
    const user = await createTestUser();
    const stranger = await createTestUser();
    const theirs = await newProject(stranger.id);
    expect(
      await createCalendarEntry(user.id, {
        title: 'Sneaky',
        entryType: 'TASK',
        startsAt: '2026-10-02',
        projectId: theirs,
      }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await setTimeZone(user.id, 'Nowhere/Special')).toMatchObject({ ok: false });
  });
});

describe('ownership', () => {
  it('hides one user’s projects from another for every operation', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const projectId = await newProject(owner.id);
    const { assetId } = unwrap(
      await addAsset(owner.id, projectId, { kind: 'TITLE', body: 'Mine' }),
    );

    const notFound = { ok: false, error: { code: 'NOT_FOUND' } };
    expect(await getProject(stranger.id, projectId)).toMatchObject(notFound);
    expect(await updateProject(stranger.id, projectId, { title: 'Stolen' })).toMatchObject(
      notFound,
    );
    expect(await deleteProject(stranger.id, projectId)).toMatchObject(notFound);
    expect(await addAsset(stranger.id, projectId, { kind: 'TITLE', body: 'x' })).toMatchObject(
      notFound,
    );
    expect(await selectAsset(stranger.id, projectId, assetId)).toMatchObject(notFound);
    expect(await compareAssets(stranger.id, projectId, assetId, assetId)).toMatchObject(notFound);
    expect(unwrap(await listProjects(stranger.id)).projects).toHaveLength(0);

    const untouched = await testPrisma.contentProject.findUniqueOrThrow({
      where: { id: projectId },
    });
    expect(untouched.title).toBe('Morning market');
  });

  it('refuses a channel the user does not own', async () => {
    const user = await createTestUser();
    expect(
      await createProject(user.id, { title: 'Wrong channel', channelId: 'not-my-channel' }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
