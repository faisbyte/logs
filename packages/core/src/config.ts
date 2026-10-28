import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// .digest/config.json: per-developer settings (gitignored with the rest of .digest/).

/** Allow and deny entries are literal strings: linear to match and can't over-allow (DECISIONS.md D20). */
export const MatcherSchema = z
  .string({ error: 'allow and deny entries must be literal strings; regular expressions are not supported (DECISIONS.md D20)' })
  .min(1);
export type Matcher = z.infer<typeof MatcherSchema>;

export const RedactionConfigSchema = z
  .object({
    allow: z.array(MatcherSchema).optional(),
    deny: z.array(MatcherSchema).optional(),
    pii: z.object({ email: z.boolean().optional(), phone: z.boolean().optional() }).strict().optional(),
    /** `false` keeps the home directory and username in session text (on by default). */
    home: z.literal(false).optional(),
  })
  // Strict: a misspelt key would otherwise silently redact less than intended.
  .strict();

export const DigestConfigSchema = z.object({ redaction: RedactionConfigSchema.default({}) });
export type DigestConfig = z.infer<typeof DigestConfigSchema>;

const CONFIG_FILE = join('.digest', 'config.json');

export function readConfig(repoRoot: string): DigestConfig {
  const file = join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) return { redaction: {} };
  try {
    return DigestConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`Invalid ${CONFIG_FILE} in ${repoRoot}: ${(err as Error).message}`);
  }
}
