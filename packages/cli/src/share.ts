import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { httpPushTarget, readConfig, type PushTarget } from '@digest/core';
import type { CliContext } from './cli.js';

/**
 * The shared store for this repo: an injected one (tests), or share.url from .digest/config.json with the
 * token from DIGEST_TOKEN or .digest/token (gitignored). The token is never printed.
 */
export function resolvePushTarget(ctx: CliContext, repoRoot: string): { target: PushTarget } | { error: string } {
  if (ctx.pushTarget) return { target: ctx.pushTarget };
  const { url } = readConfig(repoRoot).share;
  if (!url) return { error: 'no shared store is configured: set share.url in .digest/config.json to your digest server.' };
  const file = join(repoRoot, '.digest', 'token');
  const token = ctx.env.DIGEST_TOKEN?.trim() || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  if (!token) return { error: 'no token for the shared store: put the token your digest-server admin gave you in .digest/token, or set DIGEST_TOKEN.' };
  return { target: httpPushTarget(url, token) };
}
