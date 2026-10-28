import type { Detector, PlaceholderType } from './types.js';

/** A detector from a global regex; `group` picks the capture group to redact (default: whole match). */
function regexDetector(type: PlaceholderType, regex: RegExp, group = 0): Detector {
  const flags = regex.flags.includes('d') ? regex.flags : `${regex.flags}d`;
  const pattern = new RegExp(regex.source, flags.includes('g') ? flags : `${flags}g`);
  return {
    type,
    find(text) {
      return [...text.matchAll(pattern)].flatMap((m) => {
        const range = m.indices?.[group];
        return range && range[1] > range[0] ? [{ start: range[0], end: range[1] }] : [];
      });
    },
  };
}

export const DETECTORS: Detector[] = [
  regexDetector('aws_key', /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/),
];
