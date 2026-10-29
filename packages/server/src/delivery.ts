import type { RepoSettings } from '@digest/core';
import { Marked } from 'marked';
import nodemailer, { type Transporter } from 'nodemailer';

// Delivering digests (DECISIONS.md D55): a Slack incoming webhook and SMTP (Resend, Postmark or a self-hosted
// server). Webhook URLs and SMTP credentials are secrets: they come from the server's environment and never
// appear in errors, logs or the database.

export interface DeliveryMessage {
  subject: string;
  markdown: string;
}

export interface Delivery {
  readonly channel: 'slack' | 'email';
  send(message: DeliveryMessage): Promise<unknown>;
}

export class DeliveryError extends Error {}

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Raw HTML in a digest is shown as text, never passed through.
const marked = new Marked({ renderer: { html: ({ text }) => escapeHtml(text) } });

export function markdownToHtml(markdown: string): string {
  const body = marked.parse(markdown, { async: false });
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
    '<body style="font-family: -apple-system, \'Segoe UI\', Helvetica, Arial, sans-serif; line-height: 1.5; color: #1f2328; max-width: 640px; margin: 0 auto; padding: 16px;">',
    body.trim(),
    '</body></html>',
    '',
  ].join('\n');
}

/** The plain-text part: the same lines without Markdown markers. */
export function plainText(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^_(.+)_$/, '$1'))
    .join('\n');
}

const SLACK_LIMIT = 39_000;
const CUT = '\n\n(Cut short for Slack; the full digest is on the digest server.)';

/** Slack's mrkdwn: bold is *x*, there are no headings, and &, < and > must be escaped. */
export function toSlackMrkdwn(markdown: string): string {
  const text = markdown
    .split('\n')
    .map((line) => {
      const escaped = line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const heading = /^#{1,6}\s+(.*)$/.exec(escaped);
      if (heading) return `*${heading[1]!.replace(/\*\*/g, '')}*`;
      return escaped.replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/^- /, '• ');
    })
    .join('\n')
    .trim();
  return text.length <= SLACK_LIMIT ? text : `${text.slice(0, SLACK_LIMIT - CUT.length).trimEnd()}${CUT}`;
}

export class SlackWebhookDelivery implements Delivery {
  readonly channel = 'slack';
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url;
    this.#fetch = fetchImpl;
  }

  async send(message: DeliveryMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: toSlackMrkdwn(message.markdown) }) });
    } catch {
      throw new DeliveryError('slack: could not reach Slack.');
    }
    if (!response.ok) throw new DeliveryError(`slack: Slack answered ${response.status}.`);
  }
}

export class SmtpDelivery implements Delivery {
  readonly channel = 'email';

  constructor(
    private readonly transport: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
    private readonly to: string[],
  ) {}

  /** Returns what the transport reports (the JSON message for the test transport). */
  async send(message: DeliveryMessage): Promise<string> {
    try {
      const info = await this.transport.sendMail({ from: this.from, to: this.to, subject: message.subject, text: plainText(message.markdown), html: markdownToHtml(message.markdown) });
      return String((info as { message?: unknown }).message ?? info.messageId);
    } catch (err) {
      // The error can name the server; never its credentials, so only the code is kept.
      throw new DeliveryError(`email: the SMTP server refused the message (${(err as { code?: string }).code ?? 'error'}).`);
    }
  }
}

/** The deliveries a repo's settings ask for, built from the server's environment, and what is missing. */
export function deliveriesFor(
  settings: RepoSettings,
  env: Record<string, string | undefined>,
  deps: { fetchImpl?: typeof fetch; transport?: Pick<Transporter, 'sendMail'> } = {},
): { deliveries: Delivery[]; problems: string[] } {
  const deliveries: Delivery[] = [];
  const problems: string[] = [];
  if (settings.slackWebhookEnv) {
    const url = env[settings.slackWebhookEnv];
    if (!url) problems.push(`slack: ${settings.slackWebhookEnv} is not set on the server`);
    else if (!url.startsWith('https://')) problems.push(`slack: ${settings.slackWebhookEnv} must be an https URL`);
    else deliveries.push(new SlackWebhookDelivery(url, deps.fetchImpl));
  }
  if (settings.emailTo.length) {
    if (!env.SMTP_URL || !env.DIGEST_EMAIL_FROM) problems.push('email: set SMTP_URL and DIGEST_EMAIL_FROM on the server');
    else deliveries.push(new SmtpDelivery(deps.transport ?? nodemailer.createTransport(env.SMTP_URL), env.DIGEST_EMAIL_FROM, settings.emailTo));
  }
  if (!settings.slackWebhookEnv && !settings.emailTo.length) problems.push('no delivery is set up: use digest-server repo --slack-env or --email');
  return { deliveries, problems };
}
