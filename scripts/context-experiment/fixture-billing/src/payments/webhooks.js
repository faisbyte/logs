import { createHmac, timingSafeEqual } from 'node:crypto';

/** Whether an AcmePay webhook body carries a valid signature for the shared signing value. */
export function verifySignature(body, signature, signingValue) {
  const expected = createHmac('sha256', signingValue).update(body).digest('hex');
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
