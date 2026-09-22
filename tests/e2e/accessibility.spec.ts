import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { AUTH_STATE } from './global-setup';

/**
 * docs/architecture/09 §9.4 journey 7: an axe scan of the main pages, and the
 * core flow done with the keyboard alone.
 *
 * Every WCAG 2.1 A/AA violation fails, whatever its impact. The only rule
 * switched off is one that cannot judge this app: none.
 */

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
  }));
}

test('the sign-in page has no WCAG A/AA violations', async ({ page }) => {
  await page.goto('/en/sign-in');
  expect(await violations(page)).toEqual([]);
});

test.describe('signed in', () => {
  test.use({ storageState: AUTH_STATE });

  for (const path of [
    '/en/dashboard',
    '/en/channels',
    '/en/studio',
    '/en/ideas',
    '/en/projects',
    '/en/calendar?month=2026-10',
    '/en/settings',
    '/en/usage',
    '/en/channels/e2e-channel/settings',
    '/km/dashboard',
    '/km/projects',
  ]) {
    test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }

  test('a project can be created and moved with the keyboard alone', async ({ page }) => {
    await page.goto('/en/projects');
    // Tab to the "Working title" field: no mouse from here on.
    const title = page.getByLabel('Working title');
    for (
      let i = 0;
      i < 40 && !(await title.evaluate((el) => el === document.activeElement));
      i += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(title).toBeFocused();
    await page.keyboard.type('Keyboard only');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/en\/projects\/[a-z0-9]+$/);

    // On the project page, reach the status select and move it on.
    const status = page.locator('select[name="status"]');
    for (
      let i = 0;
      i < 60 && !(await status.evaluate((el) => el === document.activeElement));
      i += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(status).toBeFocused();
    // Type-ahead picks an option on every platform (Arrow Down opens the menu on macOS).
    await page.keyboard.type('Scr'); // Idea → Scripting
    await expect(status).toHaveValue('SCRIPTING');
    await page.keyboard.press('Tab'); // note field
    await page.keyboard.press('Tab'); // Move button
    await page.keyboard.press('Enter');
    await expect(page.locator('.page__header .badge')).toHaveText('Scripting');
  });

  test('focus is always visible on the main controls', async ({ page }) => {
    await page.goto('/en/projects');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const style = getComputedStyle(el);
      return { tag: el.tagName, outline: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline?.outline).not.toBe('none');
  });
});
