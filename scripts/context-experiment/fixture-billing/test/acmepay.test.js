import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcmePay } from '../src/payments/acmepay.js';

test('sends a charge, with the idempotency key as a header', async () => {
  const sent = [];
  const acmepay = createAcmePay({ request: async (method, path, options) => (sent.push({ method, path, ...options }), { id: 'ch_1', status: 'succeeded' }) });
  assert.deepEqual(await acmepay.charge({ amountCents: 500, currency: 'EUR', customerId: 'cus_1', idempotencyKey: 'abc' }), { id: 'ch_1', status: 'succeeded' });
  assert.deepEqual(sent, [{ method: 'POST', path: '/v1/charges', headers: { 'Idempotency-Key': 'abc' }, body: { amount: 500, currency: 'EUR', customer: 'cus_1' } }]);
});
