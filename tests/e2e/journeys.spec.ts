import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { expect, test, type Page } from '@playwright/test';

import { E2E_DATABASE_URL, E2E_REDIS_URL, FAKE_APIS_URL } from '../../playwright.config';

import { FAKE_CHANNEL, FAKE_IDENTITY, FAKE_TITLES, FAKE_VIDEOS } from './fake-apis/data';

/**
 * The critical journeys, end to end. docs/architecture/09 §9.4
 *
 * One signed-in browser walks through them in order, as a creator would:
 * sign in with (fake) Google → connect a channel → the worker backfills it →
 * generate titles → collect them in a project → move it through statuses onto
 * the calendar → hit an AI limit → keep working while a channel needs
 * reconnecting. Every external service is the local fake; the app, the
 * database, Redis and the worker are real.
 */

type Catalogue = Record<string, unknown>;
const load = (locale: string): Catalogue =>
  JSON.parse(readFileSync(resolve(__dirname, `../../messages/${locale}.json`), 'utf8'));
const en = load('en');
const km = load('km');
const text = (messages: Catalogue, key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Catalogue)[part], messages) as string;

const prisma = new PrismaClient({ datasourceUrl: E2E_DATABASE_URL });

test.describe.configure({ mode: 'serial' });

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await fetch(`${FAKE_APIS_URL}/__reset`);
});
test.afterAll(async () => {
  await page.close();
  await prisma.$disconnect();
});

/** Reload until `check` passes: for work the background worker finishes. */
async function eventually(check: () => Promise<void>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await page.waitForTimeout(1_500);
      await page.reload();
    }
  }
}

test('1. sign in with Google → an empty Home', async () => {
  await page.goto('/en/sign-in');
  await page.getByRole('button', { name: text(en, 'signIn.withGoogle') }).click();

  await expect(page).toHaveURL(/\/en\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(text(en, 'dashboard.title'));
  await expect(
    page.getByText(
      text(en, 'dashboard.checklist.progress').replace('{completed}', '0').replace('{total}', '5'),
    ),
  ).toBeVisible();
  expect(await (await fetch(`${FAKE_APIS_URL}/__state`)).json()).toMatchObject({ signIns: 1 });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: FAKE_IDENTITY.email } });
  expect(user.name).toBe(FAKE_IDENTITY.name);
});

test('1. connect a channel → the backfill completes → videos and analytics render', async () => {
  await page.getByRole('link', { name: text(en, 'dashboard.steps.connectChannel.action') }).click();
  await expect(page).toHaveURL(/\/en\/channels$/);
  await page.getByRole('button', { name: text(en, 'channels.connect') }).click();

  await expect(page).toHaveURL(/\/en\/channels\?connected=1$/);
  await expect(page.getByText(text(en, 'channels.flash.connected'))).toBeVisible();
  await expect(page.getByRole('heading', { name: FAKE_CHANNEL.title })).toBeVisible();

  await page.getByRole('link', { name: text(en, 'channels.viewVideos') }).click();
  await eventually(async () => {
    for (const video of FAKE_VIDEOS)
      await expect(page.getByText(video.title)).toBeVisible({ timeout: 1_000 });
  });

  // Analytics is deliberately queued 10 minutes after connecting (YouTube needs
  // the time). Fast-forward: promote the delayed job, as the clock would.
  const queue = new Queue('youtube-sync', {
    connection: { url: E2E_REDIS_URL },
    prefix: 'ysa-e2e',
  });
  const delayed = await queue.getDelayed();
  expect(delayed.map((job) => job.name)).toContain('channel.analytics');
  await Promise.all(delayed.map((job) => job.promote()));
  await queue.close();

  await page.goto(page.url().replace(/\/videos$/, '/analytics'));
  await eventually(async () => {
    await expect(page.getByText(text(en, 'analytics.empty'))).toHaveCount(0, { timeout: 1_000 });
    // Four KPI cards (views, watch time, average duration, net subscribers).
    await expect(page.locator('.kpi')).toHaveCount(4, { timeout: 1_000 });
  });
});

test('2. generate titles → save one to a project → select that version', async () => {
  await page.goto('/en/projects');
  await page.getByLabel(text(en, 'projects.new.title')).fill('Night market breakfast');
  await page.getByRole('button', { name: text(en, 'projects.new.submit') }).click();
  await expect(page).toHaveURL(/\/en\/projects\/[a-z0-9]+$/);
  const projectUrl = page.url();

  // "Generate with AI" next to Title opens Studio for this project.
  await page
    .locator('.asset-group')
    .filter({ hasText: text(en, 'content.kinds.TITLE') })
    .getByRole('link', { name: text(en, 'project.assets.generate') })
    .click();
  await expect(page).toHaveURL(/\/en\/studio\?tool=titles&project=/);
  await page.getByRole('button', { name: text(en, 'studio.generate') }).click();

  await expect(page).toHaveURL(/\/en\/studio\/results\/[a-z0-9]+\?project=/);
  await expect(page.getByText(FAKE_TITLES[1] as string)).toBeVisible();
  await page
    .getByRole('button', { name: text(en, 'results.toProject.pickTitle') })
    .nth(1)
    .click();
  await expect(page.getByRole('status')).toContainText('version 1');

  await page.goto(projectUrl);
  const version = page.locator('.version').filter({ hasText: FAKE_TITLES[1] as string });
  await expect(version).toContainText(text(en, 'project.assets.selected'));
});

test('3. an idea becomes a project → moves through statuses → appears on the calendar', async () => {
  await page.goto('/en/ideas');
  await page
    .getByLabel(text(en, 'ideas.add.title'), { exact: true })
    .fill('Five breakfasts under two dollars');
  await page.getByRole('button', { name: text(en, 'ideas.add.submit') }).click();
  await page
    .getByRole('button', { name: text(en, 'ideas.startProject') })
    .first()
    .click();
  await expect(page).toHaveURL(/\/en\/projects\/[a-z0-9]+$/);

  await page.locator('input[name="scheduledFor"]').fill('2026-12-05T18:00');
  await page.getByRole('button', { name: text(en, 'project.save') }).click();
  await expect(page.getByRole('status')).toHaveText(text(en, 'content.saved'));

  for (const status of ['SCRIPTING', 'FILMING', 'SCHEDULED']) {
    await page.locator('select[name="status"]').selectOption(status);
    await page.getByRole('button', { name: text(en, 'project.status.move') }).click();
    await expect(page.locator('.page__header .badge')).toHaveText(
      text(en, `content.statuses.${status}`),
    );
  }
  await expect(page.locator('.timeline li')).toHaveCount(4); // created + 3 moves

  await page.goto('/en/calendar?month=2026-12');
  await expect(
    page.locator('.agenda').getByRole('link', { name: 'Five breakfasts under two dollars' }),
  ).toBeVisible();
});

test('4. hitting the AI limit → a translated error → Usage shows the reset date', async () => {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: FAKE_IDENTITY.email } });
  const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  await prisma.usageCounter.upsert({
    where: { userId_periodStart_feature: { userId: user.id, periodStart, feature: 'TITLES' } },
    update: { count: 50 },
    create: { userId: user.id, periodStart, feature: 'TITLES', count: 50 },
  });

  await page.goto('/km/studio?tool=titles');
  await page.getByLabel(text(km, 'studio.fields.topic')).fill('ម្ហូបពេលព្រឹក');
  await page.getByRole('button', { name: text(km, 'studio.generate') }).click();
  await expect(page.locator('p.flash--bad[role="alert"]')).toHaveText(
    text(km, 'studio.errors.AI_LIMIT_REACHED'),
  );

  await page.goto('/km/usage');
  const titlesRow = page.getByRole('row').filter({ hasText: text(km, 'studio.tools.titles') });
  await expect(titlesRow.getByRole('cell').nth(2)).toHaveText(/^0$|^០$/);
  await expect(
    page.getByText(text(km, 'usage.ai.resets').split('{date}')[0] as string),
  ).toBeVisible();
});

test('5. a channel that needs reconnecting shows Reconnect, and the rest still works', async () => {
  await prisma.youTubeConnection.updateMany({
    where: { user: { email: FAKE_IDENTITY.email } },
    data: { status: 'REAUTH_REQUIRED' },
  });

  await page.goto('/en/channels');
  await expect(page.getByText(text(en, 'channels.needsReauth'))).toBeVisible();
  await expect(page.getByRole('button', { name: text(en, 'channels.reconnect') })).toBeVisible();

  for (const path of ['/en/dashboard', '/en/projects', '/en/calendar', '/en/studio']) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});
