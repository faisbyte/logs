import { execFileSync } from 'node:child_process';

// A repo's identity in the shared store is its normalised remote URL (DECISIONS.md D40), so the SSH and
// HTTPS forms of one repo match: "host/path", lowercase, no scheme, user, credentials, port or ".git".

const SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);

export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!SCHEMES.has(parsed.protocol)) return null;
    [host, path] = [parsed.hostname, decodeURIComponent(parsed.pathname)];
  } else {
    // scp-like syntax: [user@]host:path
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(trimmed);
    if (!scp) return null;
    [host, path] = [scp[1]!, scp[2]!];
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !path) return null;
  return `${host}/${path}`.toLowerCase();
}

/** The repo id for pushes, from the `origin` remote. The URL itself is never echoed: it may hold credentials. */
export function repoIdentity(repoRoot: string): { repoId: string } | { error: string } {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { error: 'this repo has no git remote named origin, so it has no identity in the shared store.' };
  }
  const repoId = normalizeRemoteUrl(url);
  return repoId ? { repoId } : { error: 'the origin remote is not a hosted repo URL (e.g. git@host:org/repo.git or https://host/org/repo).' };
}
