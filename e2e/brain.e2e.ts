// The clickable brain on the demo record: one click pins a card, the labels are buttons that Tab steps through
// (hubs first), Esc puts things back in order, the selection holds still when the system asks for less motion, and
// at the 20,000-point cap the brain keeps its frame budget. axe finds nothing serious in the brain's own states.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { BrainData, BrainPoint } from '../src/server/queries.ts';
import type { EntryLines } from '../src/server/organiser.ts';
import { THEMES } from '../web/src/themes.ts';
import { runFolder } from './run.ts';

const token = () => readFileSync(join(runFolder(), 'home', 'token'), 'utf8').trim();

async function openBrain(page: Page, motion: 'reduce' | 'no-preference' = 'reduce'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Every request the page makes until the brain shows, so a page that never opens says where it stopped.
  const start = Date.now();
  const log: string[] = [];
  const path = (url: string) => new URL(url).pathname;
  page.on('request', (r) => log.push(`${Date.now() - start} ms asked ${path(r.url())}`));
  page.on('requestfinished', (r) => log.push(`${Date.now() - start} ms got ${path(r.url())}`));
  page.on('requestfailed', (r) => log.push(`${Date.now() - start} ms failed ${path(r.url())}: ${r.failure()?.errorText}`));
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto(`/?seedview=brain#token=${token()}`);
  try {
    // The wait is for the server opening the record, which takes longer while other runs load the machine.
    await expect(page.locator('.brain-host canvas')).toBeVisible({ timeout: 30_000 });
  } catch (error) {
    const asked = Date.now();
    const direct = await page.request
      .get('/api/status', { headers: { 'X-Skeinwise-Token': token() } })
      .then((r) => `${r.status()} in ${Date.now() - asked} ms`)
      .catch((e: unknown) => `no answer after ${Date.now() - asked} ms: ${String(e)}`);
    throw new Error(`The brain never showed.\nRequests:\n${log.join('\n')}\nA direct GET /api/status: ${direct}`, { cause: error });
  }
  await expect(labels(page).first()).toBeAttached();
  return errors;
}

const labels = (page: Page) => page.getByRole('group', { name: 'Labelled hubs and notes' }).getByRole('button');
/** The first note label. A label takes clicks only while it shows, and one with focus always shows. */
async function noteLabel(page: Page): Promise<Locator> {
  const note = page.locator('.brain-label[aria-label$=": note"]').first();
  await note.focus();
  await expect(note).toHaveClass(/\bon\b/);
  return note;
}
const card = (page: Page) => page.locator('.part-card');
const cardTitle = (page: Page) => card(page).getByRole('heading', { level: 2 });

async function nameOf(button: Locator): Promise<string> {
  return (await button.getAttribute('aria-label')) ?? '';
}

async function api<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`/api/${path}`, { headers: { 'X-Skeinwise-Token': token() } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as T;
}

test('the labels are buttons, and Tab steps through the hubs, biggest first', async ({ page }) => {
  const errors = await openBrain(page);
  const all = labels(page);
  const names = await Promise.all((await all.all()).map(nameOf));
  // The demo record has hubs; they come first, then notes.
  const hubs = names.filter((n) => /: concept hub, [\d,]+ entr(y|ies)$/.test(n));
  expect(hubs.length).toBeGreaterThan(1);
  expect(names.slice(0, hubs.length)).toEqual(hubs);
  for (const n of names.slice(hubs.length)) expect(n).toMatch(/: note$/);
  const sizes = hubs.map((n) => Number(/([\d,]+) entr/.exec(n)![1]!.replace(/,/g, '')));
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));

  // From the brain, Tab reaches each hub in turn, and a label with focus always shows.
  await page.locator('.brain-host canvas').focus();
  for (const hub of hubs) {
    await page.keyboard.press('Tab');
    const focused = page.locator('.brain-label:focus');
    await expect(focused).toHaveAttribute('aria-label', hub);
    await expect(focused).toHaveClass(/\bon\b/);
    await expect(focused).toHaveCSS('opacity', '1');
  }

  // Enter pins the hub's card and moves focus to its title; Esc puts it away and focus back on the label.
  const last = page.locator('.brain-label:focus');
  await page.keyboard.press('Enter');
  const hubName = hubs.at(-1)!.split(': concept hub')[0]!;
  await expect(cardTitle(page)).toHaveText(hubName);
  await expect(cardTitle(page)).toBeFocused();
  await expect(card(page).getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Light its entries' })).toBeEnabled();
  await expect(card(page).getByRole('list', { name: 'Its entries' }).getByRole('listitem').first()).toBeVisible();
  await expect(page.locator('.brain-view p.sr-only[role="status"]')).toHaveText(`Selected: ${hubName}, concept hub, ${hubs.at(-1)!.split('concept hub, ')[1]}.`);
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await expect(last).toHaveAttribute('aria-label', hubs.at(-1)!);
  await expect(page.locator('.brain-label:focus')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("an entry's card lists its linked entries, lights its neighbours, and Esc puts things back in order", async ({ page }) => {
  const errors = await openBrain(page);
  const note = await noteLabel(page);
  const title = (await nameOf(note)).replace(/: note$/, '');
  await note.click();
  await expect(cardTitle(page)).toHaveText(title);
  // A mouse click leaves focus where it was.
  await expect(cardTitle(page)).not.toBeFocused();

  // The rows are what GET /api/links/:id says, each entry once, never the entry itself.
  const id = Number(await card(page).getAttribute('data-point'));
  const lines = await api<EntryLines>(page, `links/${id}`);
  const linked = new Set<number>([
    ...lines.noteLink.map((l) => l.entry),
    ...lines.hubSpoke.map((h) => -h.hub),
    ...[lines.threadLine.before, lines.threadLine.after].filter((v): v is number => v !== null),
    ...lines.crossLink.map((c) => c.entry),
  ]);
  linked.delete(id);
  expect(linked.size).toBeGreaterThan(0);
  const rows = card(page).getByRole('list', { name: 'Linked entries' }).getByRole('button');
  await expect(rows).toHaveCount(linked.size);

  // Light neighbours lights the entry, its links both ways, what reads alike and its thread neighbours.
  const around = new Set<number>([
    id,
    ...lines.noteLink.map((l) => l.entry),
    ...lines.crossLink.map((c) => c.entry),
    ...[lines.threadLine.before, lines.threadLine.after].filter((v): v is number => v !== null),
  ]);
  await card(page).getByRole('button', { name: 'Light neighbours' }).click();
  const chip = page.locator('.lit-chip');
  await expect(chip).toContainText(`Around “${title}” · ${around.size} ${around.size === 1 ? 'entry' : 'entries'}`);

  // Esc closes the card first and the lit points stay; the next Esc puts them back.
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await expect(chip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chip).toBeHidden();

  // A row selects that entry when the brain draws it: the card turns to it.
  await (await noteLabel(page)).click();
  const first = rows.first();
  const next = (await first.locator('.part-row-title').textContent())!;
  await first.click();
  await expect(cardTitle(page)).toHaveText(next);
  // Selected from inside the card, focus follows to the new card's title.
  await expect(cardTitle(page)).toBeFocused();

  // The close button closes it too.
  await card(page).getByRole('button', { name: 'Close the card' }).click();
  await expect(card(page)).toBeHidden();
  expect(errors).toEqual([]);
});

/** A spot on the canvas where the pointer finds a point (an entry unless `hub`), and its title as the hover card shows
 * it. A click there picks the same point: the click looks 16 px around, the hover 12, and the nearest wins both. */
async function findPoint(page: Page, want: 'entry' | 'hub' = 'entry'): Promise<{ x: number; y: number; title: string }> {
  const box = (await page.locator('.brain-host canvas').boundingBox())!;
  const hover = page.locator('.hover-card');
  for (let r = 0; r < 420; r += 18) {
    const step = r ? Math.max(8, 1440 / r) : 360;
    for (let a = 0; a < 360; a += step) {
      const x = box.x + box.width / 2 + r * Math.cos((a * Math.PI) / 180);
      const y = box.y + box.height / 2 - 40 + r * Math.sin((a * Math.PI) / 180);
      const onCanvas = await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName === 'CANVAS', [x, y]);
      if (!onCanvas) continue;
      await page.mouse.move(x, y);
      await page.waitForTimeout(40);
      if (!(await hover.count())) continue;
      const isHub = (await hover.textContent())!.includes('Concept hub');
      if (isHub !== (want === 'hub')) continue;
      return { x, y, title: (await hover.locator('.hover-title').textContent())!.trim() };
    }
  }
  throw new Error(`No ${want} point found under the pointer`);
}

/** A spot on the canvas with no point near it and nothing over it. */
async function findEmpty(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.brain-host canvas').boundingBox())!;
  for (const [fx, fy] of [
    [0.75, 0.3],
    [0.25, 0.7],
    [0.8, 0.7],
    [0.2, 0.3],
    [0.9, 0.5],
  ] as const) {
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;
    const onCanvas = await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName === 'CANVAS', [x, y]);
    if (!onCanvas) continue;
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    if (!(await page.locator('.hover-card').count())) return { x, y };
  }
  throw new Error('No empty spot found on the canvas');
}

test('one click on a point pins its card, a click on empty space puts it away, and double-click still opens', async ({ page }) => {
  const errors = await openBrain(page);
  const point = await findPoint(page);
  await expect(page.locator('.hover-hint').first()).toHaveText('Click to pin · double-click to open');
  await page.mouse.click(point.x, point.y);
  await expect(cardTitle(page)).toHaveText(point.title || 'Untitled');

  const empty = await findEmpty(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(card(page)).toBeHidden();

  // A drag turns the brain and selects nothing.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 60, point.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(card(page)).toBeHidden();

  const again = await findPoint(page);
  await page.mouse.dblclick(again.x, again.y);
  await expect(page.getByRole('complementary', { name: 'Reader' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a hub point pins a hub card that opens the hub and lights its entries', async ({ page }) => {
  const errors = await openBrain(page);
  const hub = await findPoint(page, 'hub');
  await page.mouse.click(hub.x, hub.y);
  await expect(cardTitle(page)).toHaveText(hub.title);
  await expect(card(page)).toContainText(/Concept hub · [\d,]+ entr/);
  await card(page).getByRole('button', { name: 'Light its entries' }).click();
  await expect(page.locator('.lit-chip')).toContainText(hub.title);
  await card(page).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.side-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the selection holds still when the system asks for less motion', async ({ page }) => {
  const errors = await openBrain(page, 'reduce');
  await labels(page).first().focus();
  await labels(page).first().click();
  await expect(card(page)).toBeVisible();
  const canvas = page.locator('.brain-host canvas');
  const mask = [page.locator('.brain-top'), page.locator('.brain-layouts'), page.locator('.legend'), card(page)];
  await page.mouse.move(1, 1);
  await page.waitForTimeout(500);
  const before = await canvas.screenshot({ mask });
  await page.waitForTimeout(1000);
  expect((await canvas.screenshot({ mask })).equals(before)).toBe(true);
  expect(errors).toEqual([]);
});

test('every control the brain adds has a name', async ({ page }) => {
  const errors = await openBrain(page);
  await (await noteLabel(page)).click();
  await expect(card(page).getByRole('list', { name: 'Linked entries' })).toBeVisible();
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('.brain-view button')]
      .filter((b) => !(b.getAttribute('aria-label') ?? (b as HTMLElement).innerText ?? '').trim())
      .map((b) => b.outerHTML.slice(0, 120)),
  );
  expect(unnamed).toEqual([]);
  expect(errors).toEqual([]);
});

test("says the brain didn't load, not that WebGL is missing, when its drawing code can't be fetched, and how to load it", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // As after a rebuild: the page asks for the scene by its old file name, and the server no longer has it.
  const sceneFile = /\/assets\/scene-[^/]*\.js$/;
  await page.route(sceneFile, (route) => route.fulfill({ status: 404, body: '' }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/?seedview=brain#token=${token()}`);
  await expect(page.getByText("The brain didn't load")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This browser can't draw the brain")).toHaveCount(0);
  await expect(page.locator('.brain-host canvas')).toHaveCount(0);
  expect(await axeFails(page, "the brain didn't load")).toEqual([]);
  // A reload would lose the token, which the page keeps in memory only, and in this tab the address only scrolls (it
  // differs in its #fragment alone): the way back is a new tab at the address serve printed.
  await expect(page.getByText('open a new tab at the address Skeinwise printed when it started')).toBeVisible();
  await expect(page.getByRole('button', { name: /reload/i })).toHaveCount(0);
  const fresh = await page.context().newPage();
  fresh.on('pageerror', (e) => errors.push(String(e)));
  await fresh.emulateMedia({ reducedMotion: 'reduce' });
  await fresh.goto(`/?seedview=brain#token=${token()}`);
  await expect(fresh.locator('.brain-host canvas')).toBeVisible({ timeout: 30_000 });
  await expect(fresh.getByText("The brain didn't load")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// axe, as e2e/axe.e2e.ts runs it (WCAG 2.0 and 2.1, A and AA; serious and critical fail), over the states that suite
// doesn't reach: a focused label, a hub's card, an entry's card with its linked entries, and the lit chip. In every
// theme, wide and compact. The canvas is left out: axe can't see into it.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** axe's serious and critical findings on the page as it stands, one line each. */
async function axeFails(page: Page, state: string): Promise<string[]> {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('.brain-host canvas').analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => {
      const at = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ');
      const why = (v.nodes[0]?.failureSummary ?? '').replace(/\s*\n\s*/g, ' ');
      return `${state}: ${v.id} (${v.impact}) ${v.help}, at ${at}. ${why}`;
    });
}

/** Serves this page the record's settings in another theme, so the record's own theme never changes. */
async function showTheme(page: Page, key: string): Promise<void> {
  await page.route('**/api/settings', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { appearance?: { theme: string } };
    if (body.appearance) body.appearance.theme = key;
    await route.fulfill({ response: res, json: body });
  });
}

for (const theme of THEMES) {
  for (const compact of [false, true]) {
    test.describe(`axe, ${theme.name}${compact ? ', compact' : ''}`, () => {
      if (compact) test.use({ viewport: { width: 390, height: 844 } });

      test('a focused label, a hub card, an entry card and the lit chip have no serious or critical finding', async ({ page }) => {
        await showTheme(page, theme.key);
        const errors = await openBrain(page);
        const fails: string[] = [];
        // The biggest hub's label. A compact window labels hubs only, so the entry card is reached through the hub's.
        const label = labels(page).first();
        await label.focus();
        await expect(label).toHaveClass(/\bon\b/);
        fails.push(...(await axeFails(page, 'a focused label')));
        await label.press('Enter');
        const rows = card(page).getByRole('list', { name: 'Its entries' }).getByRole('button');
        await expect(rows.first()).toBeVisible();
        fails.push(...(await axeFails(page, "a hub's card")));
        await rows.first().click();
        await expect(card(page).getByRole('list', { name: 'Linked entries' })).toBeVisible();
        fails.push(...(await axeFails(page, "an entry's card")));
        await card(page).getByRole('button', { name: 'Light neighbours' }).click();
        await expect(page.locator('.lit-chip')).toBeVisible();
        fails.push(...(await axeFails(page, 'the lit chip')));
        expect(fails).toEqual([]);
        expect(errors).toEqual([]);
      });
    });
  }
}

// At the cap: a 25,000-entry record as the server sends it past its cap (a 20,000-point sample, the total and each
// hub's size), served in place of the demo's.
// Headless Chromium may draw WebGL in software, and then a frame's wall time is the rasteriser's, not the brain's. So
// the budget checked here is the main thread's work in each frame: every requestAnimationFrame callback, the brain's
// tick, its picks and its draw calls included. The wall time and the renderer are reported beside it; the plan's
// frame rates (section 7.2) are measured on real graphics in Chrome's performance panel.

const DAY = 86_400_000;

/** What the server sends past its cap: `n` points as its sample, with the record's total and each hub's size. */
function bigRecord(n: number, total: number): BrainData {
  const start = Date.parse('2023-01-01T00:00:00Z');
  const points: BrainPoint[] = [];
  const threads: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const kind = i % 20 === 0 ? 2 : i % 7 === 0 ? 1 : 0;
    const thread = kind === 0 ? 1 + Math.floor(i / 12) : 0;
    if (thread) threads[String(thread)] ??= `Thread ${thread}`;
    points.push([i + 1, kind, i % 2, kind === 0 ? 1 : 2, thread, kind === 0 ? 0 : 1, -1, start + Math.floor((i / n) * 1000) * DAY + (i % 97) * 60_000, `Entry ${i + 1}`]);
  }
  const notes = points.filter((p) => p[1] === 1).map((p) => p[0]);
  const links: [number, number, number][] = [];
  for (let k = 0; k + 1 < notes.length && links.length < 3000; k += 2) links.push([notes[k]!, notes[k + 1]!, 0]);
  for (let k = 0; k < 6000; k++) links.push([1 + ((k * 7919) % n), 1 + ((k * 104_729) % n), 1]);
  const hubs = Array.from({ length: 20 }, (_, h) => {
    const entries = points.filter((_, i) => i % 20 === h).map((p) => p[0]);
    return { id: h + 1, name: `Hub ${h + 1}`, size: Math.round((entries.length * total) / n), entries };
  });
  return {
    kinds: ['message', 'note', 'file'],
    speakers: ['you', 'assistant'],
    sources: [
      { id: 1, label: 'Chat export', kind: 'chat' },
      { id: 2, label: 'notes', kind: 'notes' },
    ],
    folders: ['Inbox', 'notes'],
    projects: [],
    threads,
    points,
    total,
    links,
    hubs,
    organiser: true,
  };
}

interface Frames {
  /** Main-thread ms spent in requestAnimationFrame callbacks, per frame. */
  work: number[];
  /** Ms from one frame to the next. */
  wall: number[];
}

/** `count` frames, while `during` runs. */
async function frames(page: Page, count: number, during?: () => Promise<void>): Promise<Frames> {
  await page.evaluate(() => (window as unknown as { __work: Map<number, number> }).__work.clear());
  const run = page.evaluate(
    (n) =>
      new Promise<number[]>((resolve) => {
        const stamps: number[] = [];
        const step = (t: number) => {
          stamps.push(t);
          if (stamps.length <= n) requestAnimationFrame(step);
          else resolve(stamps);
        };
        requestAnimationFrame(step);
      }),
    count,
  );
  if (during) await during();
  const stamps = await run;
  const work = await page.evaluate((ts) => ts.slice(1).map((t) => (window as unknown as { __work: Map<number, number> }).__work.get(t) ?? 0), stamps);
  return { work, wall: stamps.slice(1).map((t, k) => t - stamps[k]!) };
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
const round = (ms: number) => Math.round(ms * 10) / 10;

// A smaller window: the software rasteriser's fill is what loads the machine, and the main thread's work per frame is
// much the same at any size. At full size it slowed the run beside it until that page missed its first wait.
test.describe('at the cap', () => {
  test.use({ viewport: { width: 800, height: 500 } });

  test('keeps its frame budget at the 20,000-point cap, turning, hovering and moving with a hub selected', async ({ page }) => {
    test.setTimeout(240_000);
    // Times every animation-frame callback, summed per frame (callbacks in one frame share its timestamp).
    await page.addInitScript(() => {
      const w = window as unknown as { __work: Map<number, number> };
      w.__work = new Map();
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) =>
        raf((t) => {
          const start = performance.now();
          try {
            cb(t);
          } finally {
            w.__work.set(t, (w.__work.get(t) ?? 0) + performance.now() - start);
          }
        });
    });
    const record = JSON.stringify(bigRecord(20_000, 25_000));
    await page.route(
      (url) => url.pathname === '/api/brain',
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: record }),
    );
    const errors = await openBrain(page, 'no-preference');
    await expect(page.locator('.legend-sample')).toContainText('Showing a sample: 20,000 of 25,000');
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    await page.waitForTimeout(1000);
    const layouts = page.getByRole('radiogroup', { name: 'Layout' });
    const settle = () => page.waitForTimeout(2500);

    const turning = await frames(page, 30);
    const box = (await page.locator('.brain-host canvas').boundingBox())!;
    const hovering = await frames(page, 30, async () => {
      for (let k = 0; k < 15; k++) await page.mouse.move(box.x + box.width * (0.3 + k / 40), box.y + box.height * 0.5);
    });
    await page.mouse.move(1, 1);
    const moving = await frames(page, 20, () => layouts.getByRole('radio', { name: 'Activity' }).click());
    await settle();
    await layouts.getByRole('radio', { name: 'Brain' }).click();
    await settle();
    // The biggest hub: about 1,000 drawn entries, so its selection draws about 1,000 spokes.
    await labels(page).first().focus();
    await labels(page).first().click();
    await expect(cardTitle(page)).toHaveText(/^Hub \d+$/);
    // Counted in the whole record, not the sample: 1,000 drawn of 1,250.
    await expect(card(page).getByText('Concept hub · 1,250 entries')).toBeVisible();
    const selectedMoving = await frames(page, 20, () => layouts.getByRole('radio', { name: 'Activity' }).click());

    const phases = { turning, hovering, moving, selectedMoving };
    const report = {
      renderer,
      work: Object.fromEntries(Object.entries(phases).map(([k, f]) => [k, { median: round(quantile(f.work, 0.5)), p90: round(quantile(f.work, 0.9)) }])),
      wall: Object.fromEntries(Object.entries(phases).map(([k, f]) => [k, round(quantile(f.wall, 0.5))])),
    };
    test.info().annotations.push({ type: 'brain at the cap', description: JSON.stringify(report) });
    console.log(`brain at the cap: ${JSON.stringify(report)}`);
    for (const [name, f] of Object.entries(phases)) {
      // The work fits a 60 fps frame, and even a slow frame keeps to the 30 fps floor.
      expect(quantile(f.work, 0.5), `${name}: median main-thread ms a frame`).toBeLessThan(16.7);
      expect(quantile(f.work, 0.9), `${name}: 90th percentile main-thread ms a frame`).toBeLessThan(33.4);
    }
    // A selection costs next to nothing while the brain moves: it is built once, and the shaders carry it.
    expect(quantile(selectedMoving.work, 0.5)).toBeLessThan(quantile(moving.work, 0.5) + 3);
    expect(errors).toEqual([]);
  });
});
