import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// .digest/config.json: per-developer settings (gitignored with the rest of .digest/).

const compiles = (m: { regex: string; flags?: string | undefined }) => {
  try {
    new RegExp(m.regex, m.flags);
    return true;
  } catch {
    return false;
  }
};

/** A literal string, or `{ "regex": "...", "flags": "i" }`. */
export const MatcherSchema = z.union([
  z.string().min(1),
  z
    .object({ regex: z.string().min(1), flags: z.string().regex(/^[imsu]*$/).optional() })
    .strict()
    .refine(compiles, { message: 'invalid regular expression' }),
]);
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
