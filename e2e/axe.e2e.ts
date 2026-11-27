// axe over the whole app: plan 7.1's gate, no serious or critical violation of WCAG 2.0 and 2.1 at A and AA. Every
// screen opens by its seed view (web/src/main.tsx) on the e2e record and is scanned in each theme, wide and in the
// compact layout. The brain's canvas is left out: t-brain's own checks cover the brain. Moderate and minor findings
// don't fail the run; each test attaches everything axe found.
//
// The page sees a theme other than the record's, and the lock and error screens, through its own rewritten
// /api/settings and /api/status answers, so the theme and the lock on the server, which the smoke test's pictures
// depend on, never change. The one write is the first run's "Set it up", which saves the chosen agents: none, since the
// scan folder is empty.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { THEMES } from '../web/src/themes.ts';
import { runFolder } from './run.ts';

// Every screen first loads the whole record. On a busy machine, or from a server still warming up for the first tests,
// that takes longer than the default five seconds.
const expect = baseExpect.configure({ timeout: 30_000 });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const FAILS = new Set(['serious', 'critical']);

const token = () => readFileSync(join(runFolder(), 'home', 'token'), 'utf8').trim();

interface Finding {
  state: string;
  rule: string;
  impact: string;
  help: string;
  targets: string[];
  /** axe's reason for the first element, such as the two colours and their ratio. */
  why: string;
}

type Scan = (state: string) => Promise<void>;

interface Screen {
  name: string;
  /** Opens the screen, then scans each state it reaches. */
  run: (page: Page, scan: Scan) => Promise<void>;
}

async function open(page: Page, seed: string, extra = ''): Promise<void> {
  await page.goto(`/?seedview=${seed}${extra}#token=${token()}`);
}

/** Opens a seed view and scans it once the given part is on screen. */
function simple(name: string, seed: string, ready: (page: Page) => Locator, extra = ''): Screen {
  return {
    name,
    run: async (page, scan) => {
      await open(page, seed, extra);
      await expect(ready(page)).toBeVisible();
      await scan(name);
    },
  };
}

const heading = (name: string) => (page: Page) => page.getByRole('heading', { name, level: 1 });
const panel = (name: string) => (page: Page) => page.getByRole('complementary', { name });
const section = (name: string) => (page: Page) => page.getByRole('region', { name });
const canvas = (page: Page) => page.locator('.brain-host canvas');

const COMMAND_BAR: Screen = {
  name: 'command bar',
  run: async (page, scan) => {
    await open(page, 'command');
    await expect(page.getByRole('dialog', { name: 'Command bar' })).toBeVisible();
    await scan('command bar, empty');
    await open(page, 'command', '&q=sqlite');
    await expect(page.getByRole('dialog', { name: 'Command bar' }).getByRole('option').first()).toBeVisible();
    await scan('command bar, with results');
  },
};

/** The Views page, empty, then a line chart, a heatmap and a list from its built-in views. */
const VIEWS: Screen = {
  name: 'views',
  run: async (page, scan) => {
    await open(page, 'views');
    await expect(heading('Views')(page)).toBeVisible();
    await scan('views');
    const views = page.getByRole('region', { name: 'Views', exact: true });
    const builtIn = views.getByRole('list', { name: 'Built in' });
    for (const [title, part] of [
      ['Each source by month', 'img'],
      ['Projects over time', 'table'],
      ['Newest entries', 'listitem'],
    ] as const) {
      await builtIn.getByRole('button', { name: title }).click();
      await expect(views.getByRole('region', { name: `View: ${title}` }).getByRole(part).first()).toBeVisible();
      await scan(`views, ${title}`);
    }
  },
};

const WIDE: Screen[] = [
  {
    name: 'first run',
    run: async (page, scan) => {
      await open(page, 'firstrun');
      const dialog = page.getByRole('dialog', { name: 'First run' });
      await expect(dialog.getByRole('heading', { name: 'Set up Skeinwise' })).toBeVisible();
      await scan('set up');
      await dialog.getByRole('button', { name: 'Set it up' }).click();
      const next = dialog.getByRole('button', { name: 'Next: bring things in' });
      await expect(next).toBeVisible();
      await scan('set up, after the checks');
      await next.click();
      await expect(dialog.getByText('Nothing found yet.')).toBeVisible();
      await scan('bring in');
    },
  },
  {
    name: 'brain',
    run: async (page, scan) => {
      await open(page, 'brain');
      await expect(canvas(page)).toBeVisible();
      await scan('brain');
      await page.getByRole('region', { name: 'Brain' }).getByRole('button', { name: 'View settings' }).click();
      await expect(page.getByRole('dialog', { name: 'View settings' })).toBeVisible();
      await scan('brain, view settings');
    },
  },
  simple('brain, brain layout', 'brain-layout', canvas),
  simple('brain, rings', 'rings', canvas),
  simple('brain, clusters', 'clusters', canvas),
  simple('threads', 'threads', (page) => page.getByRole('navigation', { name: 'Sections' })),
  simple('review', 'review', section('Review')),
  simple('runs', 'runs', section('Runs')),
  simple('hubs', 'hubs', section('Hubs')),
  simple('folders', 'folders', section('Folders')),
  simple('inbox', 'inbox', section('Inbox')),
  simple('stats', 'stats', heading('Stats')),
  simple('timeline', 'timeline', heading('Timeline')),
  simple('profile', 'profile', heading('Profile')),
  simple('workbench', 'workbench', heading('Workbench')),
  simple('activity', 'activity', heading('Workbench')),
  VIEWS,
  simple('guide', 'guide', panel('Reading your brain')),
  simple('add', 'add', panel('Add')),
  simple('reader', 'reader', (page) => panel('Reader')(page).getByRole('article')),
  simple('concept hub', 'hub', panel('Concept hub')),
  simple('editor', 'editor', (page) => page.getByRole('dialog', { name: /^Edit / })),
  simple('settings', 'settings', (page) => page.getByRole('dialog', { name: 'Settings' })),
  {
    name: 'app menu',
    run: async (page, scan) => {
      await open(page, 'menu');
      const menu = page.getByRole('menu', { name: 'Skeinwise' });
      await expect(menu).toBeVisible();
      await scan('app menu');
      await menu.getByRole('menuitem', { name: 'Connect' }).click();
      await expect(page.getByRole('menu', { name: 'Connect' })).toBeVisible();
      await scan('app menu, connect');
      await menu.getByRole('menuitem', { name: 'Get an export' }).click();
      await expect(page.getByRole('menu', { name: 'Get an export' })).toBeVisible();
      await scan('app menu, get an export');
    },
  },
  COMMAND_BAR,
  {
    name: 'locked',
    run: async (page, scan) => {
      await page.route('**/api/status', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), locked: true } });
      });
      await open(page, 'brain');
      await expect(page.getByRole('dialog', { name: 'Skeinwise is locked' })).toBeVisible();
      await scan('locked');
    },
  },
  {
    name: 'not answering',
    run: async (page, scan) => {
      await page.route('**/api/status', (route) => route.abort());
      await open(page, 'brain');
      await expect(page.getByRole('heading', { name: "Can't open the record" })).toBeVisible();
      await scan('not answering');
    },
  },
];

const COMPACT: Screen[] = [
  {
    name: 'brain',
    run: async (page, scan) => {
      await open(page, 'brain');
      await expect(canvas(page)).toBeVisible();
      await scan('brain');
      await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'More' }).click();
      await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
      await scan('brain, more');
    },
  },
  simple('threads', 'threads', (page) => page.getByRole('navigation', { name: 'Views' })),
  VIEWS,
  simple('reader', 'reader', (page) => panel('Reader')(page).getByRole('article')),
  simple('editor', 'editor', (page) => page.getByRole('dialog', { name: /^Edit / })),
  simple('add', 'add', panel('Add')),
  simple('settings', 'settings', (page) => page.getByRole('dialog', { name: 'Settings' })),
  COMMAND_BAR,
];

/** Serves this page the record's settings with another theme. */
async function showTheme(page: Page, key: string): Promise<void> {
  await page.route('**/api/settings', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { appearance?: { theme: string } };
    if (body.appearance) body.appearance.theme = key;
    await route.fulfill({ response: res, json: body });
  });
}

async function check(page: Page, info: TestInfo, screen: Screen): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const findings: Finding[] = [];
  await screen.run(page, async (state) => {
    // Past the first load's requests, so a list still loading isn't what gets scanned.
    await page.waitForLoadState('networkidle');
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).exclude('.brain-host canvas').analyze();
    for (const v of violations) {
      const targets = v.nodes.map((n) => n.target.join(' '));
      const why = (v.nodes[0]?.failureSummary ?? '').replace(/\s*\n\s*/g, ' ');
      findings.push({ state, rule: v.id, impact: v.impact ?? 'unknown', help: v.help, targets, why });
    }
  });
  await info.attach('axe findings', { body: JSON.stringify(findings, null, 2), contentType: 'application/json' });
  const where = (t: string[]) => t.slice(0, 3).join(' | ') + (t.length > 3 ? ` and ${t.length - 3} more` : '');
  const failing = findings
    .filter((f) => FAILS.has(f.impact))
    .map((f) => `${f.state}: ${f.rule} (${f.impact}) ${f.help}, at ${where(f.targets)}. ${f.why}`);
  expect(failing).toEqual([]);
  expect(errors).toEqual([]);
}

test.describe.configure({ mode: 'parallel' });

for (const theme of THEMES) {
  test.describe(`axe, ${theme.name}`, () => {
    test.beforeEach(async ({ page }) => {
      // No transitions half-way through (a fading colour isn't the colour shown), and a brain that holds still.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await showTheme(page, theme.key);
    });

    for (const screen of WIDE) test(screen.name, async ({ page }, info) => check(page, info, screen));

    test.describe('compact', () => {
      test.use({ viewport: { width: 390, height: 844 } });
      for (const screen of COMPACT) test(screen.name, async ({ page }, info) => check(page, info, screen));
    });
  });
}
