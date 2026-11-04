// Design-check screenshots against a running dashboard (default http://127.0.0.1:3000), at 1280px and 360px in dark
// and light, signed in with the token in the file given (never printed).
//   node apps/web/scripts/screenshots.mjs <token-file> <out-dir> <name>=<path> [<name>=<path> ...]
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [tokenFile, out, ...pages] = process.argv.slice(2);
const BASE = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000';
const token = readFileSync(tokenFile, 'utf8').trim();
const targets = pages.map((p) => p.split(/=(.*)/s).slice(0, 2));
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
    for (const [name, path] of targets) {
      await page.goto(`${BASE}${path}`);
      await page.waitForLoadState('networkidle');
      await page.mouse.move(0, 0);
      const file = join(out, `${name}-${width}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    }
    await context.close();
  }
}
await browser.close();
console.log(shots.join('\n'));
