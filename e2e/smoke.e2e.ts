// One pass through the app on a demo record: first run, the brain, search, the reader and the main views; then the
// brain's motion, which stops when the system asks for less.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { runFolder } from './run.ts';

const token = () => readFileSync(join(runFolder(), 'home', 'token'), 'utf8').trim();

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
  await rail.getByRole('button', { name: 'Threads' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await rail.getByRole('button', { name: 'Stats' }).click();
  await expect(page.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();
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

/** Two pictures of the brain a second apart, once it has settled. The toolbars over it are masked: their blurred
 * backdrop can shift text by a shade between frames, which is not the scene moving. */
async function twoPictures(page: Page, settled?: () => Promise<void>): Promise<[Buffer, Buffer]> {
  await page.goto(`/?seedview=brain#token=${token()}`);
  const canvas = page.locator('.brain-host canvas');
  await expect(canvas).toBeVisible();
  const mask = [page.locator('.brain-top'), page.locator('.brain-layouts'), page.locator('.legend')];
  await page.waitForTimeout(1500);
  if (settled) {
    await settled();
    // Past the labels' 0.25 s fade: a label that turned on or off just before the change finishes its fade, since a
    // transition already running keeps its length when reduced motion shortens the others.
    await page.waitForTimeout(400);
  }
  const before = await canvas.screenshot({ mask });
  await page.waitForTimeout(1000);
  return [before, await canvas.screenshot({ mask })];
}

test('holds the brain still when the system asks for less motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const [before, after] = await twoPictures(page);
  expect(after.equals(before)).toBe(true);
});

test('turns the brain when motion is allowed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const [before, after] = await twoPictures(page);
  // The control for the test above: without it, matching pictures could mean the scene never drew at all.
  expect(after.equals(before)).toBe(false);
});

test('stops turning the moment the system asks for less motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const [before, after] = await twoPictures(page, () => page.emulateMedia({ reducedMotion: 'reduce' }));
  expect(after.equals(before)).toBe(true);
});
