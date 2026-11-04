'use client';

import { Printer } from 'lucide-react';

/** Prints the page; the print stylesheet sets the digest on light paper in the serif, so "Save as PDF" makes the PDF. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="border-line text-fg-muted hover:text-fg no-print inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
      <Printer className="size-4" aria-hidden="true" />
      Print or save as PDF
    </button>
  );
}
