import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { focusRings } from './focus';

// The Cost view end to end (Phase 12, D107): a manager sees cost by developer, day and session and flags one; the developer
// sees the same rows and the flag; a reader without cost access sees none of it.

const seed = () => JSON.parse(readFileSync(new URL('./.data/seed.json', import.meta.url), 'utf8')) as Record<'repoId' | 'developer' | 'reader' | 'manager', string>;
const API = 'http://127.0.0.1:8799';
const COST = '/cost?sprint=Sprint+7';

async function signIn(page: Page, token: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Your token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}
const rows = (page: Page) => page.getByRole('table', { name: /Sessions by day/ }).getByRole('row');

test('a reader without cost access gets no link, no page, and 403 from the server', async ({ page, request }) => {
  await signIn(page, seed().reader);
  await expect(page.getByRole('link', { name: 'Cost' })).toHaveCount(0);
  await page.goto(COST);
  await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
  const session = (await page.context().cookies()).find((c) => c.name === 'logs_session')!.value;
  const headers = { authorization: `Session ${session}` };
  expect((await request.get(`${API}/v1/cost?repoId=${encodeURIComponent(seed().repoId)}&sprint=Sprint%207`, { headers })).status()).toBe(403);
  expect((await request.post(`${API}/v1/cost/flags`, { headers, data: { repoId: seed().repoId, agent: 'claude-code', sessionId: 'b0b00002-0000-4000-8000-000000000002', developerId: 'bob' } })).status()).toBe(403);
  const csv = await page.request.get('/cost/export?sprint=Sprint+7');
  expect(csv.status()).toBe(403);
});

test('a manager sees cost by developer, day and session, with commits, and no prompt or outside repo name', async ({ page }) => {
  await signIn(page, seed().manager);
  await page.getByRole('link', { name: 'Cost' }).click();
  await page.goto(COST);
  await expect(page.getByRole('region', { name: 'Totals' }).getByText('$6.50')).toBeVisible();
  await expect(page.getByText('$2.50 of this was on subscriptions: an API-equivalent estimate, not money spent.')).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByRole('link', { name: 'Commit a1b2c3d' })).toHaveAttribute('href', /github\.com\/acme\/webapp\/commit\/a1b2c3d4/);
  const body = await page.locator('body').innerText();
  for (const text of ['my-novel', 'planted prompt text', 'acme.example', 'acme/api']) expect(body).not.toContain(text);
  await page.getByRole('link', { name: 'Outside company repos' }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText('Bob');
  await page.getByRole('link', { name: 'Everywhere' }).click();
  await page.getByRole('link', { name: 'Alice', exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('link', { name: 'Show everyone' }).click();
  await expect(rows(page)).toHaveCount(5);
});

test('a manager downloads the same rows as CSV', async ({ page }) => {
  await signIn(page, seed().manager);
  const csv = await page.request.get('/cost/export?sprint=Sprint+7');
  expect(csv.headers()['content-type']).toContain('text/csv');
  const text = await csv.text();
  expect(text.trim().split('\n')).toHaveLength(5);
  expect(text).not.toContain('my-novel');
});

test('a developer sees only their own rows, exactly, and what is recorded', async ({ page }) => {
  await signIn(page, seed().developer);
  await page.goto(COST);
  await expect(page.getByRole('heading', { level: 1, name: 'Your AI cost' })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText('Bob')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Flag to discuss/ })).toHaveCount(0);
  await expect(page.getByText(/^What is recorded: for each AI request/)).toBeVisible();
});

for (const theme of ['dark', 'light'] as const) {
  test(`passes axe, keeps 3:1 focus rings and doesn't scroll sideways at 360px, in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('logs-theme', t), theme);
    for (const token of [seed().manager, seed().developer]) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await signIn(page, token);
      await page.goto(COST);
      if (token === seed().manager) await page.getByRole('button', { name: /^Flag to discuss: Bob, 2026-04-08/ }).click();
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(result.violations.map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
      const rings = await focusRings(page);
      expect(rings.filter((r) => r.width < 2 || r.ratio < 3)).toEqual([]);
      await page.setViewportSize({ width: 360, height: 780 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await page.context().clearCookies();
    }
  });
}

// Last, because it changes the seeded data.
test('a manager flags a session, the developer sees it and replies, and the manager marks it resolved', async ({ page }) => {
  await signIn(page, seed().manager);
  await page.goto(COST);
  await page.getByRole('button', { name: /^Flag to discuss: Alice, 2026-04-10/ }).click();
  await page.getByLabel('Note for Alice (optional)').fill('Which project was this for?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('To discuss', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, seed().developer);
  await page.goto(COST);
  await expect(page.getByText('Which project was this for?')).toBeVisible();
  await page.getByRole('button', { name: /^Reply/ }).click();
  await page.getByLabel('Your reply').fill('A spike for PROJ-202, not in a repo yet.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('A spike for PROJ-202, not in a repo yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, seed().manager);
  await page.goto(COST);
  await expect(page.getByText('A spike for PROJ-202, not in a repo yet.')).toBeVisible();
  await page.getByRole('button', { name: /^Mark resolved/ }).click();
  await expect(page.getByText('Resolved by Morgan (manager)')).toBeVisible();
});
