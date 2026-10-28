import { DETECTORS } from './detectors.js';
import { placeholder, type RedactionCounts, type Span } from './types.js';

export interface RedactedText {
  text: string;
  counts: RedactionCounts;
}

export function redactText(text: string): RedactedText {
  const spans: Span[] = DETECTORS.flatMap((d) => d.find(text).map((s) => ({ ...s, type: d.type }))).sort((a, b) => a.start - b.start);

  const counts: RedactionCounts = {};
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + placeholder(span.type);
    counts[span.type] = (counts[span.type] ?? 0) + 1;
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), counts };
}
