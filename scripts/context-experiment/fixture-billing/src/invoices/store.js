/**
 * An invoice record.
 * @typedef {{ number: string, issuedAt: string, customer: string, totalCents: number }} Invoice
 * `number` is "INV-<year>-<sequence>", `issuedAt` an ISO 8601 timestamp, `totalCents` the total including VAT.
 */

/** Invoices kept in memory; the production store has the same interface. */
export function memoryInvoices(list = []) {
  return {
    async all() {
      return [...list];
    },
    async byNumber(number) {
      return list.find((i) => i.number === number) ?? null;
    },
  };
}
