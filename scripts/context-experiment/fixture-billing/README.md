# billing-service

Invoices and payments for our customers.

- `src/invoices/`: invoice records, numbering and totals
- `src/payments/`: orders, card charges through AcmePay, and AcmePay webhooks
- `src/lib/`: CSV and money helpers

Run the tests with `npm test` (Node 22, no dependencies).
