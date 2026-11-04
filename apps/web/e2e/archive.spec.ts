import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The stakeholder digest archive end to end (DECISIONS.md D93): sign-in by session, what each role can reach, the
// rendered digest, the report estimate, accessibility in both themes, and no sideways scroll at 360px.

const seed = () => JSON.parse(readFileSync(new URL('./.data/seed.json', import.meta.url), 'utf8')) as { repoId: string; developer: string; reader: string; ids: Record<string, string> };
const API = 'http://127.0.0.1:8799';

async function signIn(page: Page, token: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Your token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/digests$/);
}

const sessionOf = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'logs_session')!;

test.describe('a reader', () => {
  test('sees only the digest views, and only digests readers may see', async ({ page }) => {
    await signIn(page, seed().reader);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Digests', 'Reports']);
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole('cell', { name: /Week of 2026-04-20/ })).toHaveCount(0);
    await expect(page.getByText('Withdrawn', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Corrected', { exact: true })).toHaveCount(1);
    for (const path of ['/overview', '/tickets', '/context', '/previews']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
    }
  });

  test("gets 403 from the server on developer endpoints with the dashboard's own session, whatever the UI does", async ({ page, request }) => {
    await signIn(page, seed().reader);
    const cookie = await sessionOf(page);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    const repo = encodeURIComponent(seed().repoId);
    for (const path of [`/v1/summaries?repoId=${repo}`, `/v1/context-items?repoId=${repo}`, `/v1/tickets?repoId=${repo}&sprint=Sprint%207`]) {
      expect((await request.get(`${API}${path}`, { headers: { authorization: `Session ${cookie.value}` } })).status()).toBe(403);
    }
  });

  test('reads a corrected digest, marked as corrected, with its coverage line', async ({ page }) => {
    await signIn(page, seed().reader);
    await page.getByRole('link', { name: 'Sprint 7 (2026-04-06 to 2026-04-19)' }).click();
    await expect(page.getByRole('heading', { level: 2, name: /AI work update \(corrected\)/ })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('This corrects the update sent on 2026-04-20');
    await expect(page.getByText('Based on 3 summaries that 2 developers chose to share.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
  });

  test('sees the cost and cap before a report is written', async ({ page }) => {
    await signIn(page, seed().reader);
    await page.goto('/reports');
    await page.getByLabel('Sprint').selectOption('Sprint 7');
    await page.getByRole('button', { name: 'Check the cost' }).click();
    await expect(page.getByText(/spent since \d{4}-\d{2}-01/)).toBeVisible();
    // The e2e server has no API key and no summaries: an empty period it can write without a model.
    await expect(page.getByText('No shared summaries in this period')).toBeVisible();
  });

  test('signing out ends the session on the server, so the old cookie stops working', async ({ page, request }) => {
    await signIn(page, seed().reader);
    const cookie = await sessionOf(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await request.get(`${API}/v1/whoami`, { headers: { authorization: `Session ${cookie.value}` } })).status()).toBe(401);
  });
});

test('a developer also sees digests in preview and withdrawn ones', async ({ page }) => {
  await signIn(page, seed().developer);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(5);
  await expect(page.getByText('Withdrawn', { exact: true })).toBeVisible();
  await expect(page.getByText('In preview', { exact: true })).toBeVisible();
});

test('a bad token is refused with a plain message', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Your token').fill('dgt_not-a-real-token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#token-error')).toHaveText(/That token isn't valid/);
  await expect(page.getByLabel('Your token')).toHaveAttribute('aria-invalid', 'true');
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`accessibility, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('logs-theme', t), theme);
    });

    test('every archive view passes axe (WCAG 2.1 AA)', async ({ page }) => {
      const views: [string, () => Promise<void>][] = [
        ['sign-in', async () => page.goto('/sign-in').then(() => undefined)],
        ['archive', async () => signIn(page, seed().reader)],
        ['digest', async () => page.goto(`/digests/${seed().ids.corrected}`).then(() => undefined)],
        ['reports', async () => page.goto('/reports?sprint=Sprint+7').then(() => undefined)],
      ];
      for (const [name, open] of views) {
        await open();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(result.violations.map((v) => `${name}: ${v.id} (${v.nodes.length})`)).toEqual([]);
      }
    });
  });
}

test('no view scrolls sideways at 360px, where the table stacks', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signIn(page, seed().developer);
  for (const path of ['/digests', `/digests/${seed().ids.corrected}`, '/reports?sprint=Sprint+7']) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    for (const link of await page.getByRole('navigation', { name: 'Main' }).getByRole('link').all()) await expect(link).toBeInViewport({ ratio: 1 });
  }
});

test('the skip link moves focus to the main content from the keyboard', async ({ page }) => {
  await page.goto('/sign-in');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});
