import assert from 'node:assert/strict';
import test from 'node:test';
import { toCsv } from '../src/lib/csv.js';
import { formatCents } from '../src/lib/money.js';

test('writes RFC 4180 CSV, quoting fields that need it', () => {
  assert.equal(toCsv([['a', 'b'], ['x, y', 'say "hi"']]), 'a,b\r\n"x, y","say ""hi"""\r\n');
});

test('formats cents as a decimal', () => {
  assert.equal(formatCents(129900), '1299.00');
  assert.equal(formatCents(5), '0.05');
});
