import type { Detector, PlaceholderType } from './types.js';

interface RegexOptions {
  /** Capture group to redact (default: the whole match). */
  group?: number;
  /** Extra check on the redacted text; rejects look-alikes a regex alone can't. */
  validate?: (value: string) => boolean;
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
        if (validate && !validate(text.slice(range[0], range[1]))) return [];
        return [{ start: range[0], end: range[1] }];
      });
    },
  };
}

const mixedCaseWithDigits = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

export const DETECTORS: Detector[] = [
  regexDetector('aws_key', /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/),
  // A bare 40-char secret is indistinguishable from other base64, so require an AWS key name before it.
  regexDetector('aws_secret', /(?:aws_?secret_?access_?key|SecretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/i, { group: 1 }),
  regexDetector('github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/),
  regexDetector('anthropic_key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/),
  regexDetector('openai_key', /\bsk-(?!ant-)(?:(?:proj|svcacct|admin)-)?[A-Za-z0-9_-]{20,}/, { validate: mixedCaseWithDigits }),
];
