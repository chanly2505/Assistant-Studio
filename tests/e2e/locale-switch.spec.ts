import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { AUTH_STATE } from './global-setup';

/**
 * docs/architecture/09 §9.4, journey 6: switching language translates the UI
 * AND the error messages. Error text is where i18n usually breaks: the server
 * sends a key, and the page has to render it in the reader's language.
 *
 * Expected strings are read from the catalogues themselves, so the test checks
 * the pipeline, not a particular wording.
 */

type Catalogue = Record<string, unknown>;
const catalogue = (locale: string): Catalogue =>
  JSON.parse(readFileSync(resolve(__dirname, `../../messages/${locale}.json`), 'utf8'));
const text = (messages: Catalogue, key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Catalogue)[part], messages) as string;

const en = catalogue('en');
const km = catalogue('km');
const th = catalogue('th');

async function switchTo(page: Page, label: string) {
  await page
    .getByRole('navigation', { name: /Language|ភាសា|ภาษา|Ngôn ngữ|语言/ })
    .getByRole('link', { name: label })
    .click();
}

test('signed out: the sign-in page switches to Khmer and says it is a draft', async ({ page }) => {
  await page.goto('/en/sign-in');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(text(en, 'signIn.title'));

  await switchTo(page, 'ភាសាខ្មែរ');

  await expect(page).toHaveURL(/\/km\/sign-in$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(text(km, 'signIn.title'));
  await expect(page.getByRole('note')).toContainText(text(km, 'app.draftNotice'));
});

test.describe('signed in', () => {
  test.use({ storageState: AUTH_STATE });

  test('UI and a server-side error message both follow the language switch', async ({ page }) => {
    // Create a project in English.
    await page.goto('/en/projects');
    await page.getByLabel(text(en, 'projects.new.title')).fill('E2E locale check');
    await page.getByRole('button', { name: text(en, 'projects.new.submit') }).click();
    await expect(page).toHaveURL(/\/en\/projects\/[a-z0-9]+$/);

    // Switch to Thai on the same page: the URL keeps the project.
    await switchTo(page, 'ไทย');
    await expect(page).toHaveURL(/\/th\/projects\/[a-z0-9]+$/);
    await expect(page.getByRole('navigation', { name: text(th, 'nav.main') })).toContainText(
      text(th, 'nav.projects'),
    );

    // Ask for SCHEDULED without a date: the server refuses, and the refusal
    // must arrive in Thai, not English and not as a raw key.
    const statusForm = page.locator('form').filter({ has: page.locator('select[name="status"]') });
    await statusForm.locator('select[name="status"]').selectOption('SCHEDULED');
    await statusForm.getByRole('button', { name: text(th, 'project.status.move') }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(text(th, 'errors.content.needsScheduleDate'));
    await expect(alert).not.toContainText('errors.');
    await expect(alert).not.toHaveText(text(en, 'errors.content.needsScheduleDate'));
  });

  test('changing the display language in Settings moves you to that language', async ({ page }) => {
    await page.goto('/en/settings');
    await page.getByLabel(text(en, 'settings.you.language')).selectOption('km');
    await page.getByRole('button', { name: text(en, 'settings.save') }).click();

    await expect(page).toHaveURL(/\/km\/settings\?saved=1$/);
    await expect(page.getByRole('status')).toHaveText(text(km, 'content.saved'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(text(km, 'settings.title'));
  });

  test('dates and numbers follow the language, not just the words', async ({ page }) => {
    await page.goto('/zh/calendar?month=2026-10');
    // Chinese month titles read "2026年10月", not "October 2026".
    await expect(page.getByRole('heading', { level: 2, name: /2026年10月/ })).toBeVisible();
    await page.goto('/en/calendar?month=2026-10');
    await expect(page.getByRole('heading', { level: 2, name: 'October 2026' })).toBeVisible();
  });
});
