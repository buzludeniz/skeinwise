// One pass through the app on a demo record: first run, the brain, search, the reader and the main views.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const token = () => readFileSync(join(import.meta.dirname, '.run', 'home', 'token'), 'utf8').trim();

test('opens the record, finds an entry and moves between views', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/#token=${token()}`);

  // A new record starts with the first run.
  const firstRun = page.getByRole('dialog', { name: 'First run' });
  await expect(firstRun).toBeVisible();
  await firstRun.getByRole('button', { name: 'Skip for now' }).click();
  await expect(firstRun).toBeHidden();

  // The brain draws into a canvas.
  await expect(page.locator('.brain-host canvas')).toBeVisible();

  // Search from the command bar and open the first hit in the reader.
  await page.keyboard.press('ControlOrMeta+k');
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await bar.getByRole('combobox').fill('sqlite');
  await expect(bar.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Reader' }).getByRole('article')).toContainText(/sqlite/i);

  // The rail moves between views.
  const rail = page.getByRole('navigation', { name: 'Views' });
  await rail.getByRole('button', { name: 'Navigator' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await rail.getByRole('button', { name: 'Numbers' }).click();
  await expect(page.getByRole('heading', { name: 'Numbers', level: 1 })).toBeVisible();
  await rail.getByRole('button', { name: 'Timeline' }).click();
  await expect(page.getByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible();

  // Settings open from the keyboard and close with Escape.
  await page.keyboard.press('ControlOrMeta+,');
  const settings = page.locator('.settings[role="dialog"]');
  // Focus moves into the dialog, so the keyboard works there at once.
  await expect(settings.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  expect(errors).toEqual([]);
});
