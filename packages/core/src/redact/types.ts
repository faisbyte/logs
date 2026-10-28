export type PlaceholderType = 'aws_key' | 'aws_secret' | 'github_token' | 'anthropic_key' | 'openai_key' | 'jwt' | 'private_key' | 'connection_string' | 'env_secret' | 'deny_list' | 'email' | 'phone' | 'high_entropy' | 'username' | 'home_dir' | 'unscannable';

/** When matches overlap, the merged placeholder takes the most specific type: earliest in this list. */
export const PRIORITY: readonly PlaceholderType[] = [
  'private_key',
  'aws_secret',
  'aws_key',
  'github_token',
  'anthropic_key',
  'openai_key',
  'jwt',
  'connection_string',
  'env_secret',
  'deny_list',
  'email',
  'phone',
  'high_entropy',
];

/** A literal string (DECISIONS.md D20). */
export type Matcher = string;

export interface RedactOptions {
  /** PII detectors; both on unless turned off (DECISIONS.md D14). */
  pii?: { email?: boolean | undefined; phone?: boolean | undefined } | undefined;
  /** Detected values to keep when they equal one of these literals exactly. Never overrides `deny`. */
  allow?: Matcher[] | undefined;
  /** Text to always redact as deny_list: every occurrence of each literal (case-sensitive). */
  deny?: Matcher[] | undefined;
  /** Home directory to replace with ~ (and username to redact); defaults to this machine's, `false` turns it off. */
  home?: { dir: string; username?: string | undefined } | false | undefined;
}

export type RedactionCounts = Partial<Record<PlaceholderType, number>>;

export interface Span {
  start: number;
  end: number;
  type: PlaceholderType;
}

export interface Detector {
  type: PlaceholderType;
  find(text: string): Omit<Span, 'type'>[];
}

export const placeholder = (type: PlaceholderType) => `[REDACTED:${type}]`;
