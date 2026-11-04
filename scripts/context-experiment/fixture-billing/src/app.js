import { createAcmePay } from './payments/acmepay.js';

export function createApp({ request, invoices }) {
  return { acmepay: createAcmePay({ request }), invoices };
}
