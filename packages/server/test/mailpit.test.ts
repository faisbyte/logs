// Opt-in: sends a digest email through a real SMTP server and reads it back from Mailpit's API.
// How to run it with Mailpit in Docker: docs/development.md.
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { markdownToHtml, plainText, SmtpDelivery } from '../src/delivery.js';

const smtp = process.env.DIGEST_TEST_SMTP_URL;
const mailpit = process.env.DIGEST_TEST_MAILPIT_URL;

describe.skipIf(!smtp || !mailpit)('email through Mailpit', () => {
  it('arrives with an HTML part and a plain-text part', async () => {
    const subject = `AI work update: Mailpit check ${Date.now()}`;
    const markdown = '# AI work update: Mailpit check\n\n**AI involvement: light.** Nothing much.\n\n_Based on 1 summary that 1 developer chose to share._\n';
    await new SmtpDelivery(nodemailer.createTransport(smtp!), 'digest@example.com', ['po@example.com']).send({ subject, markdown });
    const { messages } = (await (await fetch(`${mailpit}/api/v1/messages`)).json()) as { messages: { ID: string; Subject: string }[] };
    const found = messages.find((m) => m.Subject === subject);
    expect(found).toBeDefined();
    const mail = (await (await fetch(`${mailpit}/api/v1/message/${found!.ID}`)).json()) as { HTML: string; Text: string; To: { Address: string }[] };
    expect(mail.HTML.trim()).toBe(markdownToHtml(markdown).trim());
    expect(mail.Text.trim()).toBe(plainText(markdown).trim());
    expect(mail.To.map((t) => t.Address)).toEqual(['po@example.com']);
  });
});
