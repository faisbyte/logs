// RFC 4180 CSV: fields with commas, quotes or line breaks are quoted, quotes are doubled, lines end in CRLF.

const field = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Rows of values to CSV text, one line per row. */
export function toCsv(rows) {
  return rows.map((row) => row.map(field).join(',')).join('\r\n') + '\r\n';
}
