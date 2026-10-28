export type PlaceholderType = 'aws_key' | 'aws_secret' | 'github_token' | 'anthropic_key' | 'openai_key' | 'jwt' | 'private_key' | 'connection_string' | 'env_secret' | 'email' | 'phone' | 'high_entropy';

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
  'email',
  'phone',
  'high_entropy',
];

export interface RedactOptions {
  /** PII detectors; both on unless turned off (DECISIONS.md D14). */
  pii?: { email?: boolean; phone?: boolean };
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
