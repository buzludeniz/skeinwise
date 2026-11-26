// One pass through the app on a demo record: first run, the brain, search, the reader and the main views. Then the
// screens from the keyboard: focus into a side panel and back, and the rows of tabs. Then an agent's request waiting for
// a yes in Settings, and the brain's motion, which stops when the system asks for less.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { fileRequest } from '../src/mcp/requests.ts';
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

/** Opens the record past the first run: the test above skips it, and a run of one test alone skips it here. */
async function openRecord(page: Page) {
  await page.goto(`/#token=${token()}`);
  const rail = page.getByRole('navigation', { name: 'Views' });
  await expect(rail).toBeVisible();
  const firstRun = page.getByRole('dialog', { name: 'First run' });
  if (await firstRun.isVisible()) await firstRun.getByRole('button', { name: 'Skip for now' }).click();
  await expect(firstRun).toBeHidden();
  return rail;
}

test('moves focus into a side panel when it opens and back when it closes', async ({ page }) => {
  const rail = await openRecord(page);
  const guide = rail.getByRole('button', { name: 'Guide' });
  const panel = page.getByRole('complementary', { name: 'Reading your brain' });
  const heading = panel.getByRole('heading', { name: 'Reading your brain', level: 2 });

  // Opened from the keyboard, the panel takes focus on its heading. Escape closes it, and focus goes back.
  await guide.focus();
  await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(guide).toBeFocused();

  // The same through the panel's own Close button, the next stop after the heading.
  await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect(guide).toBeFocused();
});

test('keeps focus in the reader when its content changes, and moves along the tabs with the arrow keys', async ({ page }) => {
  await openRecord(page);
  await page.keyboard.press('ControlOrMeta+k');
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await bar.getByRole('combobox').fill('shed laptop');
  await expect(bar.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');

  // The hit is a message, so the reader opens on its thread, with focus on the reader's heading.
  const reader = page.getByRole('complementary', { name: 'Reader' });
  const heading = reader.getByRole('heading', { level: 2 }).first();
  await expect(heading).toHaveText('Thread');
  await expect(heading).toBeFocused();

  // A message's Open swaps the thread for the entry. The Open button goes with the thread, so focus goes to the
  // heading again rather than to the page.
  await reader.getByRole('button', { name: 'Open', exact: true }).first().focus();
  await page.keyboard.press('Enter');
  await expect(heading).toHaveText('Entry');
  await expect(heading).toBeFocused();

  // The layers: only the selected tab is in the Tab order, and the arrows, Home and End move along the row.
  const tab = (name: string) => reader.getByRole('tablist', { name: 'Layers' }).getByRole('tab', { name, exact: true });
  await expect(tab('Original')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Cleaned')).toHaveAttribute('tabindex', '-1');
  await tab('Original').focus();
  const steps: [string, string][] = [
    ['ArrowRight', 'Cleaned'],
    ['End', 'Ideas'],
    ['ArrowRight', 'Original'],
    ['ArrowLeft', 'Ideas'],
    ['Home', 'Original'],
    ['ArrowRight', 'Cleaned'],
  ];
  for (const [key, name] of steps) {
    await page.keyboard.press(key);
    await expect(tab(name)).toBeFocused();
    await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
    await expect(reader.getByRole('tabpanel', { name })).toBeVisible();
  }
  // Tab leaves the row for the layer itself.
  await page.keyboard.press('Tab');
  await expect(reader.getByRole('tabpanel', { name: 'Cleaned' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(reader).toBeHidden();
});

test("moves along Workbench's tabs and its choices with the arrow keys", async ({ page }) => {
  const rail = await openRecord(page);
  await rail.getByRole('button', { name: 'Workbench' }).click();
  const tab = (name: string) => page.getByRole('tablist', { name: 'Workbench' }).getByRole('tab', { name, exact: true });
  await tab('Table builder').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Activity')).toBeFocused();
  await expect(tab('Activity')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Table builder')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByRole('tabpanel', { name: 'Activity' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Table builder')).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Table builder' })).toBeVisible();

  // A row of choices is a radio group: only the chosen one is in the Tab order, and the arrows move and choose. The
  // table builder opens on Heatmap.
  const radio = (name: string) => page.getByRole('radiogroup', { name: 'Form' }).getByRole('radio', { name, exact: true });
  await expect(radio('Heatmap')).toHaveAttribute('aria-checked', 'true');
  await expect(radio('Heatmap')).toHaveAttribute('tabindex', '0');
  await expect(radio('Table')).toHaveAttribute('tabindex', '-1');
  await radio('Heatmap').focus();
  const steps: [string, string][] = [
    ['ArrowRight', 'Bars'],
    ['ArrowDown', 'Stacked bars'],
    ['ArrowUp', 'Bars'],
    ['ArrowLeft', 'Heatmap'],
    ['ArrowLeft', 'Table'],
    ['ArrowLeft', 'Dots'],
  ];
  for (const [key, name] of steps) {
    await page.keyboard.press(key);
    await expect(radio(name)).toBeFocused();
    await expect(radio(name)).toHaveAttribute('aria-checked', 'true');
  }
});

test("waits for a yes before an agent's request changes anything, and shows its words as text", async ({ page }) => {
  const home = join(runFolder(), 'home');
  const now = new Date().toISOString();
  fileRequest(home, { agent: 'test-agent', tool: 'undo_run', target: 9999, what: 'Undo run 9999, made by test-agent' }, now);
  fileRequest(home, { agent: 'test-agent', tool: 'not_mine', target: 1, what: 'Leave out thread 1, "<b>Plot</b> offers"' }, now);

  await openRecord(page);
  await page.keyboard.press('ControlOrMeta+,');
  const card = page.locator('.settings[role="dialog"]').getByRole('region', { name: 'Waiting for your yes' });
  await expect(card.getByRole('listitem')).toHaveCount(2);
  // A thread title comes from the record, so it shows as the words it is.
  await expect(card.getByText('Leave out thread 1, "<b>Plot</b> offers"', { exact: true })).toBeVisible();

  // The run is gone: Confirm says so, the request is dropped either way, and focus moves to the next one.
  await card.getByRole('button', { name: 'Confirm' }).first().click();
  await expect(page.locator('.toast-error')).toContainText('There is no run 9999.');
  await expect(card.getByRole('listitem')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeFocused();

  // Refused: nothing changes, nothing else waits, and focus goes to the card's heading.
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: 'Refuse' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').last()).toContainText('Refused: Leave out thread 1');
  await expect(card.getByText('Nothing else waits for your yes.')).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Waiting for your yes' })).toBeFocused();
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
