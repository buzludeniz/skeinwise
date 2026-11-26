// Views, end to end: describe a view, the local model draws its spec, the page renders it with the Workbench's chart
// and list, and it is saved; then, under No-AI, the saved view still shows and drawing says it needs the local model.
// The local model is a fake on a 127.0.0.1 port of this test's own, never a model server running on this computer.
// The test is skipped until App.tsx mounts the page (the lead wires it at merge); after that it must run.
//
// smoke.e2e.ts may run beside this file on the same record and expects the first-run dialog, so this test never
// finishes the first run: `?seedview=numbers` opens the app on Numbers with the dialog shut, and nothing is saved.

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page, test } from '@playwright/test';

const mounted = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'App.tsx'), 'utf8').includes('ViewsPage');
const token = () => readFileSync(join(import.meta.dirname, '.run', 'home', 'token'), 'utf8').trim();

const DRAWN = { v: 1, title: 'Notes by month', show: 'chart', form: 'bars', x: 'time', where: [{ prop: 'kind', is: 'note' }] };

let model: Server;
let modelPort = 0;
let asked = 0;

test.beforeAll(async () => {
  model = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-e2e-model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      asked++;
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(DRAWN) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  modelPort = (model.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => model.close(() => resolve()));
});

async function settings(request: APIRequestContext, patch: Record<string, unknown>) {
  const res = await request.put('/api/settings', { headers: { 'X-Skeinwise-Token': token() }, data: patch });
  expect(res.ok(), await res.text()).toBe(true);
}

async function openViews(page: Page) {
  await expect(page.getByRole('heading', { name: 'Numbers', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Views' }).click();
  await expect(page.getByRole('heading', { name: 'Views', level: 1 })).toBeVisible();
  return page.getByRole('region', { name: 'Views', exact: true });
}

test('describes, draws, renders and saves a view; under No-AI the saved view still shows', async ({ page, request }) => {
  test.skip(!mounted, 'App.tsx does not mount ViewsPage yet.');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The local engine, pointed at the fake model.
  await settings(request, { ai: { engine: 'local', local: { address: `http://127.0.0.1:${modelPort}/v1` } } });

  await page.goto(`/?seedview=numbers#token=${token()}`);
  let views = await openViews(page);

  // Describe, and the model's spec is checked and drawn with the Workbench's chart.
  await views.getByLabel('Describe a view').fill('my notes, month by month');
  await views.getByRole('button', { name: 'Draw', exact: true }).click();
  const drawn = views.getByRole('region', { name: 'View: Notes by month' });
  await expect(drawn).toContainText('Drawn by the local model (fake-e2e-model)');
  await expect(drawn.getByRole('img', { name: /^Bars of entries/ })).toBeVisible();
  expect(asked).toBe(1);

  // Pick another form by hand, then save.
  await drawn.getByRole('radiogroup', { name: 'Form' }).getByRole('radio', { name: 'Table' }).click();
  await expect(drawn.getByRole('table')).toBeVisible();
  await drawn.getByRole('button', { name: 'Save view' }).click();
  const saved = views.getByRole('list', { name: 'Saved', exact: true });
  await expect(saved.getByRole('button', { name: 'Notes by month', exact: true })).toBeVisible();
  await expect(drawn).toContainText('A saved view');

  // No-AI: the saved view still renders, and drawing says it needs the local model.
  await settings(request, { ai: { engine: 'none' } });
  await page.reload();
  views = await openViews(page);
  await expect(views.getByRole('note')).toContainText('Drawing a new view needs the local model');
  await expect(views.getByLabel('Describe a view')).toHaveCount(0);
  await saved.getByRole('button', { name: 'Notes by month', exact: true }).click();
  await expect(views.getByRole('region', { name: 'View: Notes by month' }).getByRole('table')).toBeVisible();

  // A built-in list shows the newest entries.
  await views.getByRole('list', { name: 'Built in' }).getByRole('button', { name: 'Newest entries' }).click();
  const newest = views.getByRole('region', { name: 'View: Newest entries' });
  await expect(newest.getByRole('listitem').first()).toBeVisible();
  expect(asked).toBe(1);
  expect(errors).toEqual([]);
});
