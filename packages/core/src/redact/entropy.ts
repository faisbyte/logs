import type { Detector } from './types.js';

// Unknown high-entropy strings (DECISIONS.md D13). Calibrated against random base62 tokens and
// the IDs, hashes, paths and identifiers that fill real sessions.

const MIN_LENGTH = 20;
const CANDIDATE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

// Shapes that look random but are identifiers, blanked out before candidates are extracted.
const SAFE_SHAPES = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // UUIDs (session ids)
  /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g, // SRI integrity hashes in lockfiles
  /\b(?:toolu|srvtoolu|msg|req|call|resp|rs|fc|file|batch|chatcmpl|run|thread|asst|step)_[A-Za-z0-9]+/g, // API object ids
  /\b(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d{3}|sk-ssh-ed25519@openssh\.com) AAAA[A-Za-z0-9+/]+={0,3}/g, // SSH public keys
  /\d{8}T(?:\d{2,6}(?:\.\d+)?Z?)?/g, // compact ISO 8601 dates and times in file names
  /ABCDEFGHIJKLMNOPQRSTUVWXYZ|abcdefghijklmnopqrstuvwxyz/g, // alphabet constants
];

const PUBLIC_PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]+ ){0,3}(?:PUBLIC KEY|CERTIFICATE(?: REQUEST)?)-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,60}-----/y;

/** Blanks public PEM blocks. Linear: the next END marker is found once and reused across BEGIN markers. */
function blankPublicPem(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  let nextEnd = -1;
  for (const begin of text.matchAll(PUBLIC_PEM_BEGIN)) {
    if (nextEnd < begin.index) nextEnd = text.indexOf('-----END ', begin.index);
    if (nextEnd === -1) break;
    if (nextEnd - begin.index > 16_384) continue;
    PEM_END.lastIndex = nextEnd;
    const end = PEM_END.exec(text);
    if (!end || begin.index < cursor) continue;
    const stop = nextEnd + end[0].length;
    pieces.push(text.slice(cursor, begin.index), ' '.repeat(stop - begin.index));
    cursor = stop;
  }
  return pieces.length ? pieces.join('') + text.slice(cursor) : text;
}

function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/**
 * Share of alphanumerics inside dictionary-like runs (`User`, `factor`, `HTML`): high for identifiers
 * and names, low for random text. Separators don't count, so `a__b-c` names score like `aBC`.
 */
const wordiness = (s: string) =>
  (s.match(/[A-Z]?[a-z]{3,}|[A-Z]{4,}/g) ?? []).join('').length / (s.match(/[A-Za-z0-9]/g) ?? []).length;

export function looksRandom(token: string): boolean {
  const s = token.replace(/=+$/, '');
  if (s.length < MIN_LENGTH) return false;
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/[0-9]/.test(s)) return false;
  if (/^[0-9a-f_-]+$/i.test(s)) return false; // hex: git SHAs and content hashes
  if (wordiness(s) >= 0.62) return false;
  // Random base62 of length n has entropy close to log2(min(n, 64)); allow the gap seen at its 99.5th percentile.
  const ceiling = Math.log2(Math.min(s.length, 64));
  return ceiling - shannon(s) <= 0.5 + 0.01 * Math.min(s.length, 64);
}

export const highEntropyDetector: Detector = {
  type: 'high_entropy',
  find(text) {
    const scanned = SAFE_SHAPES.reduce((t, shape) => t.replace(shape, (m) => ' '.repeat(m.length)), blankPublicPem(text));
    const spans: { start: number; end: number }[] = [];
    for (const m of scanned.matchAll(CANDIDATE)) {
      // Absolute paths are judged one segment at a time; other tokens (base64 with '/') as a whole.
      const pieces = m[0].startsWith('/') ? m[0].split('/') : [m[0]];
      let offset = m.index;
      for (const piece of pieces) {
        if (looksRandom(piece)) spans.push({ start: offset, end: offset + piece.length });
        offset += piece.length + 1;
      }
    }
    return spans;
  },
};
