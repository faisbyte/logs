// Design-check screenshots of the archive and one digest, at 1280px and 360px, dark and light, against a running
// dashboard (default http://127.0.0.1:3000) signed in with the token in the file given (never printed).
//   node apps/web/scripts/screenshots.mjs <token-file> <out-dir>
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [tokenFile, out] = process.argv.slice(2);
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000';
const token = readFileSync(tokenFile, 'utf8').trim();
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const shots = [];
for (const theme of ['dark', 'light']) {
  for (const width of [1280, 360]) {
    const context = await browser.newContext({ viewport: { width, height: width === 360 ? 780 : 900 }, deviceScaleFactor: width === 360 ? 2 : 1 });
    await context.addInitScript((t) => localStorage.setItem('logs-theme', t), theme);
    const page = await context.newPage();
    await page.goto(`${BASE}/sign-in`);
    await page.getByLabel('Your token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/digests$/);
    await page.waitForLoadState('networkidle');
    const archive = join(out, `archive-${width}-${theme}.png`);
    await page.screenshot({ path: archive, fullPage: true });
    // The newest sent digest: the corrected Sprint 1 digest in the real data.
    await page.getByRole('row').filter({ hasText: 'Sent' }).first().getByRole('link').click();
    await page.waitForURL(/\/digests\/[^/]+$/);
    await page.getByRole('heading', { level: 2 }).first().waitFor();
    await page.waitForLoadState('networkidle');
    const digest = join(out, `digest-${width}-${theme}.png`);
    await page.screenshot({ path: digest, fullPage: true });
    shots.push(archive, digest);
    await context.close();
  }
}
await browser.close();
console.log(shots.join('\n'));
