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
    // The e2e server has no API key, so it says it can't write this report, and offers no button to try.
    await expect(page.getByText('2 summaries from 2 developers')).toBeVisible();
    await expect(page.getByText('The server has no API key, so it can only show reports it has already written.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Write the report' })).toHaveCount(0);
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

test.describe('the archive list', () => {
  test('makes each row one link: a click anywhere on it opens the digest', async ({ page }) => {
    await signIn(page, seed().reader);
    // A real pointer click on the coverage cell, not the link: the row's link covers the whole row.
    const cell = (await page.getByRole('row').filter({ hasText: 'Report' }).getByRole('cell').nth(3).boundingBox())!;
    await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
    await expect(page).toHaveURL(new RegExp(`/digests/${seed().ids.report}$`));
  });

  test('is navigable by keyboard alone: one tab stop per row, Enter opens it, with a visible focus ring', async ({ page }) => {
    await signIn(page, seed().developer);
    const links = page.getByRole('table').getByRole('link');
    await expect(links).toHaveCount(4);
    await links.first().focus();
    for (let i = 1; i < 4; i++) {
      await page.keyboard.press('Tab');
      await expect(links.nth(i)).toBeFocused();
    }
    const outline = await page.getByRole('table').getByRole('row').nth(4).evaluate((row) => getComputedStyle(row).outlineStyle);
    expect(outline).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/digests\/[^/]+$/);
  });
});

test.describe('layout', () => {
  test('shows who is signed in, and their role in full, at 360px too, for both roles', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    for (const [token, name, role] of [[seed().reader, 'Pat (PO)', 'reader'], [seed().developer, 'Alice', 'developer']] as const) {
      await signIn(page, token);
      const line = page.getByRole('banner').locator('p').filter({ visible: true });
      await expect(line).toHaveText(`${name} · ${role}`);
      await expect(line.getByText(`· ${role}`)).toBeInViewport({ ratio: 1 });
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
  });

  test('puts each ticket of a combined heading on its own line at 360px, and on one line on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page, seed().reader);
    await page.goto(`/digests/${seed().ids.corrected}`);
    const [first, second] = await page.locator('h3 [data-ticket]').all();
    expect((await second!.boundingBox())!.y).toBeGreaterThan((await first!.boundingBox())!.y + 10);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(Math.abs((await second!.boundingBox())!.y - (await first!.boundingBox())!.y)).toBeLessThan(4);
  });

  test('centres the digest column on desktop, with the back link and print button aligned to it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, seed().reader);
    await page.goto(`/digests/${seed().ids.corrected}`);
    const doc = (await page.locator('article.digest').boundingBox())!;
    const back = (await page.getByRole('link', { name: '← All digests' }).boundingBox())!;
    const print = (await page.getByRole('button', { name: 'Print or save as PDF' }).boundingBox())!;
    expect(Math.abs(doc.x + doc.width / 2 - 640)).toBeLessThan(2);
    expect(Math.abs(back.x - doc.x)).toBeLessThan(1);
    expect(Math.abs(print.x + print.width - (doc.x + doc.width))).toBeLessThan(1);
  });

  test('drops the digest card at 360px so the text uses the full width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page, seed().reader);
    await page.goto(`/digests/${seed().ids.corrected}`);
    const style = await page.locator('article.digest').evaluate((el) => ({ border: getComputedStyle(el).borderTopWidth, padding: getComputedStyle(el.lastElementChild!).paddingLeft }));
    expect(style).toEqual({ border: '0px', padding: '0px' });
  });
});

test.describe('theme default by role', () => {
  test.use({ colorScheme: 'light' });

  test('a reader follows the system theme; a developer starts dark; a stored choice wins for both', async ({ page }) => {
    await signIn(page, seed().reader);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, seed().developer);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Light theme' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('developer views', () => {
  test('a developer gets Tickets and Context in the nav', async ({ page }) => {
    await signIn(page, seed().developer);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Tickets', 'Context', 'Digests', 'Reports']);
  });

  test('the ticket timeline shows approved summaries oldest first, with decisions and dropped approaches marked', async ({ page }) => {
    await signIn(page, seed().developer);
    await page.goto('/tickets');
    await page.getByRole('link', { name: 'PROJ-201' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Account lockout' })).toBeVisible();
    const entries = page.getByRole('list', { name: 'Summaries, oldest first' }).getByRole('listitem', { name: /,/ });
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toHaveAttribute('aria-label', '2026-04-07, Alice');
    await expect(page.locator('[data-marker="decision"]').first()).toBeVisible();
    await expect(page.locator('[data-marker="attention"]').first()).toBeVisible();
  });

  test('the context view shows the brief for a path in a terminal, and items by status', async ({ page }) => {
    await signIn(page, seed().developer);
    await page.goto('/context');
    await page.getByLabel('Path or ticket').fill('src/auth');
    await page.getByRole('button', { name: 'Show the brief' }).click();
    const panel = page.getByRole('region', { name: 'sprintdigest context src/auth' });
    await expect(panel).toContainText('Counting failed logins in process memory was tried and dropped.');
    await expect(page.getByRole('link', { name: /Active/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(4);
    await page.getByRole('link', { name: /Superseded/ }).click();
    await expect(page.getByText('Superseded by ctx-e2e00002')).toBeVisible();
    await page.getByRole('link', { name: /Retired/ }).click();
    await expect(page.getByText('Retired by alice')).toBeVisible();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`pass axe (WCAG 2.1 AA) in the ${theme} theme and don't scroll sideways at 360px`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('logs-theme', t), theme);
      await signIn(page, seed().developer);
      for (const path of ['/tickets', '/tickets/PROJ-201', '/context?path=src%2Fauth', '/context?status=superseded']) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(path);
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(result.violations.map((v) => `${path}: ${v.id} (${v.nodes.length})`)).toEqual([]);
        await page.setViewportSize({ width: 360, height: 780 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      }
    });
  }
});

