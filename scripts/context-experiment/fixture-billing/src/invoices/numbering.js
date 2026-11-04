/** The next invoice number after `last` (or the first of the year): INV-2026-0001, INV-2026-0002, … */
export function nextInvoiceNumber(year, last = null) {
  const sequence = last && last.startsWith(`INV-${year}-`) ? Number(last.slice(-4)) + 1 : 1;
  return `INV-${year}-${String(sequence).padStart(4, '0')}`;
}
