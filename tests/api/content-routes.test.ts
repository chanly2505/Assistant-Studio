import { randomBytes } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryRateLimiter, setRateLimiter } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/cookies';

import { createTestUser, disconnectDatabase, resetDatabase, testPrisma } from '../helpers/db';

const APP = 'http://localhost:3000';
const route = {
  ideas: () => import('@/app/api/v1/ideas/route'),
  idea: () => import('@/app/api/v1/ideas/[ideaId]/route'),
  projects: () => import('@/app/api/v1/projects/route'),
  project: () => import('@/app/api/v1/projects/[projectId]/route'),
  assets: () => import('@/app/api/v1/projects/[projectId]/assets/route'),
  asset: () => import('@/app/api/v1/projects/[projectId]/assets/[assetId]/route'),
  calendar: () => import('@/app/api/v1/calendar/route'),
  entry: () => import('@/app/api/v1/calendar/[entryId]/route'),
  timezone: () => import('@/app/api/v1/me/timezone/route'),
};

beforeEach(async () => {
  await resetDatabase();
  setRateLimiter(new InMemoryRateLimiter());
});
afterAll(() => disconnectDatabase());

async function signedIn() {
  const user = await createTestUser();
  const token = randomBytes(32).toString('hex');
  await testPrisma.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const send = (method: string, url: string, body?: unknown, cookie?: string, origin = APP) =>
  new Request(`${APP}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin,
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const data = async (response: Response) => (await response.json()).data;

describe('content API', () => {
  it('requires a session everywhere', async () => {
    const { GET } = await route.projects();
    expect((await GET(send('GET', '/api/v1/projects'))).status).toBe(401);
    const calendar = await route.calendar();
    expect((await calendar.GET(send('GET', '/api/v1/calendar?month=2026-10'))).status).toBe(401);
  });

  it('refuses a cross-site write', async () => {
    const { cookie } = await signedIn();
    const { POST } = await route.projects();
    const response = await POST(
      send('POST', '/api/v1/projects', { title: 'x' }, cookie, 'https://evil.example'),
    );
    expect(response.status).toBe(403);
  });

  it('rejects unknown fields and bad values with 422', async () => {
    const { cookie } = await signedIn();
    const { POST } = await route.projects();
    expect(
      (await POST(send('POST', '/api/v1/projects', { title: 'ok', userId: 'someone' }, cookie)))
        .status,
    ).toBe(422);
    const calendar = await route.calendar();
    expect(
      (await calendar.GET(send('GET', '/api/v1/calendar?month=2026-13', undefined, cookie))).status,
    ).toBe(422);
  });

  it('runs the whole flow: idea → project → versions → schedule → calendar', async () => {
    const { cookie } = await signedIn();

    const ideas = await route.ideas();
    const idea = await ideas.POST(
      send('POST', '/api/v1/ideas', { title: 'Riverside noodles' }, cookie),
    );
    expect(idea.status).toBe(201);
    const { ideaId } = await data(idea);

    const projects = await route.projects();
    const promoted = await projects.POST(send('POST', '/api/v1/projects', { ideaId }, cookie));
    expect(promoted.status).toBe(201);
    const { projectId } = await data(promoted);

    const assets = await route.assets();
    const version = await assets.POST(
      send(
        'POST',
        `/api/v1/projects/${projectId}/assets`,
        { kind: 'TITLE', body: 'Better title' },
        cookie,
      ),
      params({ projectId }),
    );
    expect(version.status).toBe(201);
    const { assetId, version: number } = await data(version);
    expect(number).toBe(2);

    const asset = await route.asset();
    const selected = await asset.PATCH(
      send('PATCH', `/api/v1/projects/${projectId}/assets/${assetId}`, { selected: true }, cookie),
      params({ projectId, assetId }),
    );
    expect(selected.status).toBe(200);

    const timezone = await route.timezone();
    expect(
      (await timezone.PUT(send('PUT', '/api/v1/me/timezone', { timezone: 'Asia/Bangkok' }, cookie)))
        .status,
    ).toBe(200);

    const project = await route.project();
    const scheduled = await project.PATCH(
      send(
        'PATCH',
        `/api/v1/projects/${projectId}`,
        { scheduledFor: '2026-10-20T19:00', status: 'SCHEDULED' },
        cookie,
      ),
      params({ projectId }),
    );
    expect(scheduled.status).toBe(200);

    const calendar = await route.calendar();
    const month = await data(
      await calendar.GET(send('GET', '/api/v1/calendar?month=2026-10', undefined, cookie)),
    );
    expect(month.zone).toBe('Asia/Bangkok');
    expect(month.items).toEqual([
      expect.objectContaining({
        type: 'project',
        title: 'Riverside noodles',
        dayKey: '2026-10-20',
      }),
    ]);

    const detail = await data(
      await project.GET(
        send('GET', `/api/v1/projects/${projectId}`, undefined, cookie),
        params({ projectId }),
      ),
    );
    expect(detail.status).toBe('SCHEDULED');
    expect(detail.assets.find((a: { isSelected: boolean }) => a.isSelected).body).toBe(
      'Better title',
    );
  });

  it('answers 422 with the schedule message when scheduling without a date', async () => {
    const { cookie } = await signedIn();
    const projects = await route.projects();
    const { projectId } = await data(
      await projects.POST(send('POST', '/api/v1/projects', { title: 'No date yet' }, cookie)),
    );
    const project = await route.project();
    const response = await project.PATCH(
      send('PATCH', `/api/v1/projects/${projectId}`, { status: 'SCHEDULED' }, cookie),
      params({ projectId }),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error.messageKey).toBe('errors.content.needsScheduleDate');
  });

  it('answers 404 for another user’s project and calendar entry', async () => {
    const owner = await signedIn();
    const stranger = await signedIn();
    const projects = await route.projects();
    const { projectId } = await data(
      await projects.POST(send('POST', '/api/v1/projects', { title: 'Private' }, owner.cookie)),
    );
    const calendar = await route.calendar();
    const { entryId } = await data(
      await calendar.POST(
        send(
          'POST',
          '/api/v1/calendar',
          { title: 'Private too', startsAt: '2026-10-02' },
          owner.cookie,
        ),
      ),
    );

    const project = await route.project();
    expect(
      (
        await project.GET(
          send('GET', `/api/v1/projects/${projectId}`, undefined, stranger.cookie),
          params({ projectId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await project.DELETE(
          send('DELETE', `/api/v1/projects/${projectId}`, undefined, stranger.cookie),
          params({ projectId }),
        )
      ).status,
    ).toBe(404);
    const entry = await route.entry();
    expect(
      (
        await entry.DELETE(
          send('DELETE', `/api/v1/calendar/${entryId}`, undefined, stranger.cookie),
          params({ entryId }),
        )
      ).status,
    ).toBe(404);
    expect(await testPrisma.calendarEntry.count()).toBe(1);
  });

  it('archives an idea and refuses to delete a promoted one', async () => {
    const { cookie } = await signedIn();
    const ideas = await route.ideas();
    const { ideaId } = await data(
      await ideas.POST(send('POST', '/api/v1/ideas', { title: 'Promoted' }, cookie)),
    );
    const projects = await route.projects();
    await projects.POST(send('POST', '/api/v1/projects', { ideaId }, cookie));

    const idea = await route.idea();
    const response = await idea.DELETE(
      send('DELETE', `/api/v1/ideas/${ideaId}`, undefined, cookie),
      params({ ideaId }),
    );
    expect(response.status).toBe(409);

    const listed = await data(
      await ideas.GET(send('GET', '/api/v1/ideas?status=PROMOTED', undefined, cookie)),
    );
    expect(listed.ideas).toHaveLength(1);
  });
});
