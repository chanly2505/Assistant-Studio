import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { AUTH_STATE } from './global-setup';

type Catalogue = Record<string, unknown>;
const en = JSON.parse(
  readFileSync(resolve(__dirname, '../../messages/en.json'), 'utf8'),
) as Catalogue;
const text = (key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Catalogue)[part], en) as string;

test.use({ storageState: AUTH_STATE });

// Regression: the save action threw "locale is not defined" on submit.
test('describing a channel saves and shows the answers again', async ({ page }) => {
  await page.goto('/en/channels/e2e-channel/settings');
  await page.getByLabel(text('channelSettings.niche')).fill('Street food in Phnom Penh');
  await page.getByLabel(text('channelSettings.audience')).fill('Visitors and locals');
  await page.getByLabel(text('channelSettings.keywords')).fill('street food, phnom penh');
  await page.getByRole('button', { name: text('channelSettings.save') }).click();

  await expect(page).toHaveURL(/\/en\/channels\/e2e-channel\/settings\?saved=1$/);
  await expect(page.getByRole('status')).toHaveText(text('content.saved'));
  await expect(page.getByLabel(text('channelSettings.niche'))).toHaveValue(
    'Street food in Phnom Penh',
  );
  await expect(page.getByLabel(text('channelSettings.keywords'))).toHaveValue(
    'street food, phnom penh',
  );
});

test('saving user settings keeps the chosen time zone and default channel', async ({ page }) => {
  await page.goto('/en/settings');
  await page.getByLabel(text('settings.you.timezone')).selectOption('Asia/Phnom_Penh');
  await page.getByLabel(text('settings.content.channel')).selectOption('e2e-channel');
  await page.getByRole('button', { name: text('settings.save') }).click();

  await expect(page).toHaveURL(/\/en\/settings\?saved=1$/);
  await expect(page.getByLabel(text('settings.you.timezone'))).toHaveValue('Asia/Phnom_Penh');
  await expect(page.getByLabel(text('settings.content.channel'))).toHaveValue('e2e-channel');
});
