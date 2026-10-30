import { defaultRepoSettings } from '@digest/core';
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { deliveriesFor, markdownToHtml, plainText, SlackWebhookDelivery, SmtpDelivery, toSlackMrkdwn } from '../src/delivery.js';

// Delivering a digest (DECISIONS.md D55): Slack incoming webhook and SMTP. Webhook URLs and SMTP passwords are
// secrets: they live in the server's environment and never appear in errors or logs.

const REPO = 'github.com/acme/webapp';
const markdown = [
  '# AI work update: Sprint 1 (2026-03-02 to 2026-03-15)',
  '',
  'Login is safer <script>alert(1)</script> now.',
  '',
  '## PROJ-142: Rate limit login',
  '',
  '**AI involvement: heavy.** The AI wrote most of it.',
  '',
  '- Keep the limiter in memory.',
  '',
  '_Based on 3 summaries that 2 developers chose to share._',
  '',
].join('\n');
const message = { subject: 'AI work update: Sprint 1', markdown };
const fakeHook = 'https://hooks.slack.com/services/T000/B000/not-a-real-hook';

describe('rendering', () => {
  it('renders Markdown to a small HTML email, escaping any raw HTML', () => {
    const html = markdownToHtml(markdown);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<h1>AI work update: Sprint 1 (2026-03-02 to 2026-03-15)</h1>');
    expect(html).toContain('<h2>PROJ-142: Rate limit login</h2>');
    expect(html).toContain('<strong>AI involvement: heavy.</strong>');
    expect(html).toContain('<li>Keep the limiter in memory.</li>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('writes a plain-text part without Markdown markers', () => {
    const text = plainText(markdown);
    expect(text).toContain('AI work update: Sprint 1 (2026-03-02 to 2026-03-15)\n');
    expect(text).toContain('PROJ-142: Rate limit login');
    expect(text).toContain('AI involvement: heavy. The AI wrote most of it.');
    expect(text).toContain('- Keep the limiter in memory.');
    expect(text).toContain('Based on 3 summaries that 2 developers chose to share.');
    expect(text).not.toMatch(/\*\*|^#/m);
  });

  it("converts Markdown to Slack's mrkdwn, and cuts very long digests short", () => {
    expect(toSlackMrkdwn(markdown)).toContain('*AI work update: Sprint 1 (2026-03-02 to 2026-03-15)*');
    expect(toSlackMrkdwn(markdown)).toContain('*PROJ-142: Rate limit login*');
    expect(toSlackMrkdwn(markdown)).toContain('*AI involvement: heavy.* The AI wrote most of it.');
    expect(toSlackMrkdwn(markdown)).toContain('• Keep the limiter in memory.');
    expect(toSlackMrkdwn(markdown)).toContain('&lt;script&gt;');
    const long = toSlackMrkdwn(`# Big\n\n${'word '.repeat(10_000)}`);
    expect(long.length).toBeLessThanOrEqual(39_000);
    expect(long).toMatch(/\(Cut short for Slack; the full digest is on the digest server\.\)$/);
  });
});

describe('SlackWebhookDelivery', () => {
  it('posts the mrkdwn text to the webhook', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('ok', { status: 200 }))) as typeof fetch;
    await new SlackWebhookDelivery(fakeHook, fetchImpl).send(message);
    expect(calls[0]!.url).toBe(fakeHook);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: toSlackMrkdwn(markdown) });
  });

  it('fails clearly without ever showing the webhook URL', async () => {
    const answered = new SlackWebhookDelivery(fakeHook, (async () => new Response('no_service', { status: 404 })) as typeof fetch);
    const refused = await answered.send(message).catch((e: Error) => e);
    expect(String(refused)).toMatch(/Slack answered 404/);
    const down = new SlackWebhookDelivery(fakeHook, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const unreachable = await down.send(message).catch((e: Error) => e);
    expect(String(unreachable)).toMatch(/could not reach Slack/);
    for (const e of [refused, unreachable]) expect(String(e)).not.toContain('not-a-real-hook');
  });
});

describe('SmtpDelivery', () => {
  it('sends HTML with a plain-text part to every recipient', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent = await new SmtpDelivery(transport, 'digest@example.com', ['po@example.com', 'sm@example.com']).send(message);
    const mail = JSON.parse(sent);
    expect(mail).toMatchObject({ subject: 'AI work update: Sprint 1', from: { address: 'digest@example.com' }, to: [{ address: 'po@example.com' }, { address: 'sm@example.com' }] });
    expect(mail.html).toBe(markdownToHtml(markdown));
    expect(mail.text).toBe(plainText(markdown));
  });
});

describe('deliveriesFor', () => {
  const env = { SLACK_WEBHOOK_URL: fakeHook, SMTP_URL: 'smtp://localhost:1025', DIGEST_EMAIL_FROM: 'digest@example.com' };

  it('sets up Slack and email from the repo settings and the server environment', () => {
    const settings = { ...defaultRepoSettings(REPO), slackWebhookEnv: 'SLACK_WEBHOOK_URL', emailTo: ['po@example.com'] };
    const { deliveries, problems } = deliveriesFor(settings, env);
    expect(deliveries.map((d) => d.channel)).toEqual(['slack', 'email']);
    expect(problems).toEqual([]);
  });

  it('names what is missing, without values', () => {
    const settings = { ...defaultRepoSettings(REPO), slackWebhookEnv: 'SLACK_WEBHOOK_ACME', emailTo: ['po@example.com'] };
    expect(deliveriesFor(settings, { SLACK_WEBHOOK_ACME: 'http://insecure.example.com/hook' }).problems).toEqual([
      'slack: SLACK_WEBHOOK_ACME must be an https URL',
      'email: set SMTP_URL and DIGEST_EMAIL_FROM on the server',
    ]);
    expect(deliveriesFor(settings, {}).problems).toEqual(['slack: SLACK_WEBHOOK_ACME is not set on the server', 'email: set SMTP_URL and DIGEST_EMAIL_FROM on the server']);
    expect(deliveriesFor(defaultRepoSettings(REPO), env)).toEqual({ deliveries: [], problems: ['no delivery is set up: use sprintdigest-server repo --slack-env or --email'] });
  });
});
