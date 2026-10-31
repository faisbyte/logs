import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { contextBrief, ensureDigestDir, formatTime, type ContextItem } from '@digest/core';
import type { CliContext } from './cli.js';
import { connect } from './tickets.js';

// sprintdigest context [path|ticket] (DECISIONS.md D78): a brief of the team's active context items, picked by code
// with no model call. The active items are cached in .digest/ so the brief still works offline.

interface Cache {
  repoId: string;
  fetchedAt: string;
  items: ContextItem[];
}

const cachePath = (repoRoot: string) => join(repoRoot, '.digest', 'context-cache.json');

function readCache(repoRoot: string, repoId: string): Cache | null {
  try {
    const cache = JSON.parse(readFileSync(cachePath(repoRoot), 'utf8')) as Cache;
    return cache.repoId === repoId ? cache : null;
  } catch {
    return null;
  }
}

/** A path that exists relative to the current directory becomes repo-relative; anything else is used as given. */
function repoTarget(target: string | undefined, repoRoot: string, cwd: string): string | undefined {
  if (target === undefined || /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(target)) return target;
  const onDisk = resolve(cwd, target);
  const inRepo = relative(repoRoot, onDisk);
  return existsSync(onDisk) && inRepo && !inRepo.startsWith('..') ? inRepo.split('\\').join('/') : target;
}

export async function contextCommand(target: string | undefined, options: { repo?: string }, ctx: CliContext): Promise<number> {
  const c = connect('context', options.repo, ctx);
  if ('exit' in c) return c.exit;
  let items: ContextItem[];
  try {
    const result = await c.target.contextItems(c.repoId);
    if (result.status !== 'ok') return c.fail(`the store refused the token: ${result.reason}`);
    items = result.items.filter((i) => i.status === 'active');
    const cache: Cache = { repoId: c.repoId, fetchedAt: ctx.now().toISOString(), items };
    writeFileSync(join(ensureDigestDir(c.repoRoot), 'context-cache.json'), `${JSON.stringify(cache, null, 2)}\n`);
  } catch (err) {
    const cache = readCache(c.repoRoot, c.repoId);
    if (!cache) return c.fail(`${(err as Error).message} No notes are cached here yet.`);
    ctx.stderr(`sprintdigest context: the shared store is unreachable, so these are the notes fetched at ${formatTime(cache.fetchedAt, ctx.timeZone)}${ctx.timeZone ? ` ${ctx.timeZone}` : ''}.\n`);
    items = cache.items;
  }
  ctx.stdout(contextBrief(items, repoTarget(target, c.repoRoot, ctx.cwd)));
  return 0;
}

export async function contextRetireCommand(id: string, options: { repo?: string }, ctx: CliContext): Promise<number> {
  const c = connect('context retire', options.repo, ctx);
  if ('exit' in c) return c.exit;
  const result = await c.target.retireContextItem(c.repoId, id);
  switch (result.status) {
    case 'retired':
      return (ctx.stdout(`Retired ${id}. It will not come back on its own.\n`), 0);
    case 'already':
      return (ctx.stdout(`${id} was already retired.\n`), 0);
    case 'not-found':
      return c.fail(`no context item ${id} on the shared store.`);
    default:
      return c.fail(`the store refused the token: ${result.reason}`);
  }
}
