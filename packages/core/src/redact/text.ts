import { allowFilter, detectorsFor } from './detectors.js';
import { placeholder, PRIORITY, type RedactionCounts, type RedactOptions, type Span } from './types.js';

export interface RedactedText {
  text: string;
  counts: RedactionCounts;
}

/** Overlapping spans become one span covering all of them, typed by the most specific detector. */
function merge(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (PRIORITY.indexOf(span.type) < PRIORITY.indexOf(last.type)) last.type = span.type;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

const EXISTING_PLACEHOLDER = /\[REDACTED:[a-z_]+\]/g;

/** Compiles detectors, allow and deny lists once; the returned function redacts one string. */
export function createRedactor(options: RedactOptions = {}): (text: string) => RedactedText {
  const detectors = detectorsFor(options);
  const allowed = allowFilter(options.allow ?? []);

  return (text) => {
    // Detectors see existing placeholders as blanks, so redacting twice changes nothing.
    const scanned = text.replace(EXISTING_PLACEHOLDER, (p) => ' '.repeat(p.length));
    const found = detectors.flatMap((d) => d.find(scanned).map((s) => ({ ...s, type: d.type })));
    const spans = merge(found.filter((s) => s.type === 'deny_list' || !allowed(text.slice(s.start, s.end))));

    const counts: RedactionCounts = {};
    let out = '';
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start) + placeholder(span.type);
      counts[span.type] = (counts[span.type] ?? 0) + 1;
      cursor = span.end;
    }
    return { text: out + text.slice(cursor), counts };
  };
}

export function redactText(text: string, options: RedactOptions = {}): RedactedText {
  return createRedactor(options)(text);
}
