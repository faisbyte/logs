/** Line totals in cents with VAT, rounded per line, half up. */
export function lineTotalCents({ unitCents, quantity, vatPercent }) {
  const net = unitCents * quantity;
  return net + Math.round((net * vatPercent) / 100);
}

export function invoiceTotalCents(lines) {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}
