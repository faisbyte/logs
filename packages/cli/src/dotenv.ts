import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Fills unset variables from a .env file (DECISIONS.md D26). Existing environment variables win,
 * empty values are skipped, and nothing is ever printed.
 */
export function loadDotEnv(file: string, env: Record<string, string | undefined>): void {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (value && env[key] === undefined) env[key] = value;
  }
}
