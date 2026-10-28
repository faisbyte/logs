import { readFileSync } from 'node:fs';

/** Reads a JSONL file, skipping blank and unparseable lines (a live session can end mid-line). */
export function readJsonl<T>(path: string): T[] {
  const rows: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // skip
    }
  }
  return rows;
}

export const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];
