// Client for AcmePay, our card payment provider. `request(method, path, { headers, body })` sends one HTTP request and
// resolves with the parsed JSON response; a network timeout rejects with an error whose code is 'ETIMEDOUT'.

export function createAcmePay({ request }) {
  return {
    /**
     * Charges a customer. With an idempotencyKey, AcmePay treats a repeat of the same key within 24 hours as the
     * original request and returns its result instead of charging again.
     */
    async charge({ amountCents, currency, customerId, idempotencyKey }) {
      const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
      return request('POST', '/v1/charges', { headers, body: { amount: amountCents, currency, customer: customerId } });
    },
    async refund({ chargeId, amountCents }) {
      return request('POST', '/v1/refunds', { headers: {}, body: { charge: chargeId, amount: amountCents } });
    },
  };
}
