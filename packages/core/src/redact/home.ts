import { homedir, userInfo } from 'node:os';
import { placeholder, type RedactionCounts } from './types.js';

// The home directory becomes ~ so usernames never leave the machine (DECISIONS.md D19).

export interface HomeOptions {
  dir: string;
  username?: string | undefined;
}

// Usernames too common to identify anyone; replacing them would mangle ordinary words.
const GENERIC_USERNAMES = new Set(['root', 'admin', 'administrator', 'user', 'dev', 'developer', 'ubuntu', 'runner', 'vscode', 'node', 'ec2-user', 'codespace', 'builder', 'ci', 'app', 'guest', 'test']);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function defaultHome(): HomeOptions | null {
  try {
    const dir = homedir();
    let username: string | undefined;
    try {
      username = userInfo().username;
    } catch {
      // no passwd entry (some containers): the path is still replaced
    }
    return { dir, username };
  } catch {
    return null;
  }
}

export function homeReplacer(home: HomeOptions): (text: string) => { text: string; counts: RedactionCounts } {
  const dir = home.dir.replace(/\/+$/, '');
  if (!dir) return (text) => ({ text, counts: {} });
  const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
  const paths = new RegExp(`${escape(dir)}(?![\\w-])|(?<![A-Za-z0-9])${escape(encoded)}(?![A-Za-z0-9])`, 'g');
  const name = home.username && home.username.length >= 3 && !GENERIC_USERNAMES.has(home.username.toLowerCase()) ? home.username : null;
  const username = name ? new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?![A-Za-z0-9])`, 'g') : null;

  return (text) => {
    const counts: RedactionCounts = {};
    let out = text.replace(paths, () => {
      counts.home_dir = (counts.home_dir ?? 0) + 1;
      return '~';
    });
    if (username) {
      out = out.replace(username, () => {
        counts.username = (counts.username ?? 0) + 1;
        return placeholder('username');
      });
    }
    return { text: out, counts };
  };
}
