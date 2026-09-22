import { expect, test, type Page } from '@playwright/test';

import { AUTH_STATE } from './global-setup';

/**
 * The production Content-Security-Policy, in a real browser.
 * docs/architecture/08 §8.3
 *
 * A CSP that blocks the app's own scripts breaks it silently: the page renders
 * from the server, then nothing is interactive. So every page below must load
 * with zero CSP violations, and must still hydrate (a client component works).
 */

function collectViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (execute|load|apply|connect|frame)/i.test(text)) {
      violations.push(text);
    }
  });
  return violations;
}

test('pages send a nonce-based CSP and the full header set', async ({ page }) => {
  const response = await page.goto('/en/sign-in');
  const headers = response?.headers() ?? {};
  const csp = headers['content-security-policy'] ?? '';

  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' 'strict-dynamic'/);
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("form-action 'self' https://accounts.google.com");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['strict-transport-security']).toContain('max-age=');

  // A fresh nonce per request: a reused nonce is a guessable one.
  const again = await page.goto('/en/sign-in');
  expect(again?.headers()['content-security-policy']).not.toBe(csp);
});

test('API responses deny everything', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.headers()['content-security-policy']).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
});

test('signed-out pages load and hydrate with no CSP violations', async ({ page }) => {
  const violations = collectViolations(page);
  await page.goto('/en');
  await page.goto('/en/sign-in');
  // The language switcher is a client component: if scripts were blocked it
  // would still render (server HTML) but links would be plain navigations.
  // Hydration is checked through React's marker on the root.
  await page.waitForFunction(() => '__next_f' in window);
  expect(violations).toEqual([]);
});

test.describe('signed in', () => {
  test.use({ storageState: AUTH_STATE });

  for (const path of [
    '/en/dashboard',
    '/en/channels',
    '/en/studio',
    '/en/ideas',
    '/en/projects',
    '/en/calendar',
    '/en/settings',
    '/en/usage',
    '/en/channels/e2e-channel/settings',
    '/km/dashboard',
  ]) {
    test(`${path} loads with no CSP violations`, async ({ page }) => {
      const violations = collectViolations(page);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(violations).toEqual([]);
    });
  }

  test.describe('in a known browser time zone', () => {
    // Fixed so the prompt always has something to offer (the user's saved
    // zone is never Pacific/Auckland in this suite).
    test.use({ timezoneId: 'Pacific/Auckland' });

    test('client-side interaction works under the CSP (time-zone prompt)', async ({ page }) => {
      // The prompt is a client component that reads the browser's zone after
      // hydration; its button only exists if React ran.
      await page.goto('/en/settings');
      await expect(
        page.getByRole('button', { name: 'Use Pacific/Auckland instead' }),
      ).toBeVisible();
    });
  });
});
