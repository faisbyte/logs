import { randomUUID } from 'node:crypto';

/** A new order: `id` is a UUID, `currency` an upper-case ISO 4217 code, `totalCents` an integer. */
export function newOrder({ customerId, totalCents, currency }) {
  return { id: randomUUID(), customerId, totalCents, currency: currency.toUpperCase(), status: 'open' };
}
