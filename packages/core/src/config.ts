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

export const SummarizeConfigSchema = z
  .object({
    /** Anthropic model ID; defaults to the fast, cheap model (DECISIONS.md D21). */
    model: z.string().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    /** Estimated input tokens per chunk; long sessions are split into chunks this size. */
    chunkTokens: z.number().int().min(1_000).max(500_000).optional(),
  })
  .strict();

export const ReviewConfigSchema = z
  .object({
    /** Approve new summaries automatically, marked approvedBy "auto"; for solo or trusted setups. Off by default. */
    autoApprove: z.boolean().optional(),
  })
  .strict();

export const ShareConfigSchema = z
  .object({
    /** The digest server pushes go to (DECISIONS.md D43). The token is never stored here: see .digest/token or DIGEST_TOKEN. */
    url: z.url({ protocol: /^https?$/, error: 'share.url must be an http(s) URL' }).optional(),
  })
  .strict();

/** A short regular expression that compiles and never matches empty text (DECISIONS.md D44). */
const TicketPatternSchema = z
  .string()
  .max(100, 'tickets.pattern must be at most 100 characters')
  .superRefine((pattern, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: `tickets.pattern is not a valid regular expression: ${(err as Error).message}` });
      return;
    }
    if (re.test('')) ctx.addIssue({ code: 'custom', message: 'tickets.pattern must not match empty text' });
  });

export const TicketsConfigSchema = z
  .object({
    /** Ticket keys in branch names (and commit messages, with `keys`). Defaults to keys like PROJ-142. */
    pattern: TicketPatternSchema.optional(),
    /** Project keys that count, e.g. ["PROJ"]. Setting them also turns on keys from commit messages. */
    keys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/, 'tickets.keys are project keys such as PROJ')).optional(),
  })
  .strict();
export type TicketsConfig = z.infer<typeof TicketsConfigSchema>;

export const DigestConfigSchema = z.object({
  redaction: RedactionConfigSchema.default({}),
  summarize: SummarizeConfigSchema.default({}),
  review: ReviewConfigSchema.default({}),
  share: ShareConfigSchema.default({}),
  tickets: TicketsConfigSchema.default({}),
});
export type DigestConfig = z.infer<typeof DigestConfigSchema>;

const CONFIG_FILE = join('.digest', 'config.json');

export function readConfig(repoRoot: string): DigestConfig {
  const file = join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) return { redaction: {}, summarize: {}, review: {}, share: {}, tickets: {} };
  try {
    return DigestConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`Invalid ${CONFIG_FILE} in ${repoRoot}: ${(err as Error).message}`);
  }
}
