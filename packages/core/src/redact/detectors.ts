import { highEntropyDetector } from './entropy.js';
import type { Detector, PlaceholderType, RedactOptions } from './types.js';

interface RegexOptions {
  /** Capture group to redact (default: the whole match). */
  group?: number;
  /** Extra check on the redacted text (and the text before it); rejects look-alikes a regex alone can't. */
  validate?: (value: string, before: string) => boolean;
}

function regexDetector(type: PlaceholderType, regex: RegExp, { group = 0, validate }: RegexOptions = {}): Detector {
  const flags = regex.flags.includes('d') ? regex.flags : `${regex.flags}d`;
  const pattern = new RegExp(regex.source, flags.includes('g') ? flags : `${flags}g`);
  return {
    type,
    find(text) {
      return [...text.matchAll(pattern)].flatMap((m) => {
        const range = m.indices?.[group];
        if (!range || range[1] <= range[0]) return [];
        if (validate && !validate(text.slice(range[0], range[1]), text.slice(Math.max(0, range[0] - 200), range[0]))) return [];
        return [{ start: range[0], end: range[1] }];
      });
    },
  };
}

const mixedCaseWithDigits = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

// Key names that suggest a secret value (DECISIONS.md D12): *SECRET*, *TOKEN*, *PASSWORD*, *API_KEY*, ...
const SECRET_KEY =
  '[\\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth(?![a-z])|authorization|credentials?|session[_-]?key|signing[_-]?key|encryption[_-]?key|dsn)[\\w.-]*';
// Values that are references, types or placeholders rather than secrets.
const NOT_A_SECRET =
  /^(?:\$\{?[\w.]+\}?|%\w+%|\{\{.*\}\}|<[^>]*>|(?:process\.)?env\.\w+|os\.environ.*|true|false|null|none|nil|undefined|string|number|boolean|bool|str|int|any|unknown|object|\d+(?:\.\d+)?|\*+|x+)$/i;
const looksSecret = (value: string) => !NOT_A_SECRET.test(value);
const SCHEME = '(?:(?:Bearer|Basic|Token)[ \\t]+)?';
const envSecret = (pattern: string, flags = 'i') => regexDetector('env_secret', new RegExp(pattern, flags), { group: 1, validate: looksSecret });

const digitCount = (min: number, max: number) => (s: string) => {
  const n = s.replace(/\D/g, '').length;
  return n >= min && n <= max;
};

// Not an email: an SSH remote (git@github.com:org/repo) or the user part of a URL (ssh://git@host, https://u:p@host).
const insideUrlAuthority = (before: string) => /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i.test(before);
export const emailDetector = regexDetector(
  'email',
  /(?<![\w.+-])[\w.%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b(?!:\S)/,
  { validate: (_value, before) => !insideUrlAuthority(before) },
);

// Formatted numbers only: +international, (area) code, national leading 0, US dashed.
export const phoneDetectors: Detector[] = [
  regexDetector('phone', /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])/, { validate: digitCount(8, 15) }),
  regexDetector('phone', /(?<![\w)])\(\d{2,4}\)[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w-])/, { validate: digitCount(8, 12) }),
  regexDetector('phone', /(?<![\w.+-])0\d{1,3}[ -]\d{3,4}[ -]\d{3,4}(?![\w-])/, { validate: digitCount(9, 12) }),
  regexDetector('phone', /(?<![\w.-])\d{3}-\d{3}-\d{4}(?![\w-])/),
];

export const SECRET_DETECTORS: Detector[] = [
  regexDetector('aws_key', /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/),
  // A bare 40-char secret is indistinguishable from other base64, so require an AWS key name before it.
  regexDetector('aws_secret', /(?:aws_?secret_?access_?key|SecretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/i, { group: 1 }),
  regexDetector('github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/),
  regexDetector('anthropic_key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/),
  regexDetector('jwt', /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/),
  // Whole PEM block; with no END line (truncated output) it runs to the end of the text.
  regexDetector('private_key', /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/),
  regexDetector('openai_key', /\bsk-(?!ant-)(?:(?:proj|svcacct|admin)-)?[A-Za-z0-9_-]{20,}/, { validate: mixedCaseWithDigits }),
  // scheme://user:password@host: redact the user:password part.
  regexDetector('connection_string', /\b[a-zA-Z][a-zA-Z0-9+.-]{1,30}:\/\/([^\s:@/?#]*:[^\s@/?#]+)@/, { group: 1 }),
  // KEY=value with no spaces (.env, shell, CLI flags, query strings).
  envSecret(`(?<![\\w.-])${SECRET_KEY}=(?!["'])([^\\s"'&;,)}\\]]{1,512})`),
  // key = "value" / "key": "value" (JSON, code, quoted .env).
  envSecret(`(?<![\\w.-])["']?${SECRET_KEY}["']?\\s*[:=]\\s*"([^"\\n]{1,512})"`),
  envSecret(`(?<![\\w.-])["']?${SECRET_KEY}["']?\\s*[:=]\\s*'([^'\\n]{1,512})'`),
  // key: value at the start of a line (YAML, header dumps) or inside a quoted header (curl -H "...").
  envSecret(`^[ \\t-]*${SECRET_KEY}:[ \\t]+${SCHEME}([^\\s"',;{}()\\[\\]]{1,512})`, 'im'),
  envSecret(`["']${SECRET_KEY}:[ \\t]*${SCHEME}([^\\s"',;{}()\\[\\]]{1,512})`),
  highEntropyDetector,
];

export function detectorsFor(options: RedactOptions): Detector[] {
  return [
    ...SECRET_DETECTORS,
    ...(options.pii?.email === false ? [] : [emailDetector]),
    ...(options.pii?.phone === false ? [] : phoneDetectors),
  ];
}
