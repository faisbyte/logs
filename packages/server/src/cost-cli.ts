import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ADMIN_ACTOR,
  describeTelemetry,
  disableCost,
  enableCost,
  grantCost,
  issueIngestToken,
  removeAccount,
  removePattern,
  revokeCost,
  revokeIngestToken,
  saveAccount,
  savePattern,
  savePrice,
  type AuditAction,
  type SharedStore,
} from '@digest/core';

// The admin's side of AI cost tracking (Phase 12, DECISIONS.md D107): `sprintdigest-server cost <subcommand>`.

export const COST_USAGE = `       sprintdigest-server cost enable --repo <repo> --developers-told | cost disable --repo <repo>
       sprintdigest-server cost account --repo <repo> [--email <e> --developer <id> --name <name> [--org <organisation id>] [--billing api|subscription] | --email <e> --remove]
       sprintdigest-server cost grant --repo <repo> --reader <id> [--revoke]
       sprintdigest-server cost company [--match <host/org/repo or host/org/*> [--remove]]
       sprintdigest-server cost telemetry-token --label <name> [--revoke]
       sprintdigest-server cost price --model <id> --since <date> --input <usd> --output <usd> [--cache-read <usd>] [--cache-write <usd>]   (per million tokens)
       sprintdigest-server cost retention --days <n>|forever
       sprintdigest-server cost delete --developer <id> --yes
       sprintdigest-server cost status
       sprintdigest-server cost trial [--port 4318]`;

export const COST_COMMANDS = ['enable', 'disable', 'account', 'grant', 'company', 'telemetry-token', 'price', 'retention', 'delete', 'status', 'trial'];
/** Personal monitoring data isn't kept for good unless the admin says so. */
export const DEFAULT_COST_DAYS = 365;

export interface CostArgs {
  repo?: string;
  developer?: string;
  reader?: string;
  name?: string;
  email?: string;
  org?: string;
  billing?: string;
  match?: string;
  label?: string;
  model?: string;
  since?: string;
  input?: string;
  output?: string;
  'cache-read'?: string;
  'cache-write'?: string;
  days?: string;
  'developers-told'?: boolean;
  remove?: boolean;
  revoke?: boolean;
  yes?: boolean;
}

interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Days AI cost is kept; null keeps it for good. */
export async function costRetentionDays(store: SharedStore): Promise<number | null> {
  const [set] = await store.costConfig('retention');
  return set ? set.days || null : DEFAULT_COST_DAYS;
}

/** Deletes AI cost past its retention; returns a line to print when anything went. */
export async function applyCostRetention(store: SharedStore, now: Date): Promise<string | null> {
  const days = await costRetentionDays(store);
  if (days === null) return null;
  const before = new Date(now.getTime() - days * 86_400_000).toISOString();
  const gone = await store.purgeUsageBefore(before);
  return gone ? `AI cost kept ${days} days: deleted ${count(gone, 'record', 'records')} from before ${before.slice(0, 10)}\n` : null;
}

export async function costCommand(sub: string, values: CostArgs, repoId: string | null, store: SharedStore, io: Io): Promise<number> {
  const fail = (message: string) => (io.stderr(`sprintdigest-server: ${message}\n`), 1);
  const now = new Date();
  const audit = (repo: string, action: AuditAction, target: string | null, detail: string | null = null) => store.recordAudit({ repoId: repo, at: now.toISOString(), ...ADMIN_ACTOR, action, target, detail });

  if (['enable', 'disable', 'account', 'grant'].includes(sub) && !repoId) return fail('--repo must be a repo URL or host/path id, e.g. github.com/acme/webapp.');

  switch (sub) {
    case 'enable':
      if (!values['developers-told']) {
        return fail(
          'cost tracking shows each developer’s AI cost to people you grant access. Tell the developers on this repo first: what is recorded, who sees it and for how long ' +
            '(docs/cost-tracking.md has a notice to send). Some places require written notice by law. Then run this again with --developers-told.',
        );
      }
      await enableCost(store, repoId!, now);
      await audit(repoId!, 'cost.enabled', null, 'the admin confirmed developers were told');
      io.stdout(`Cost tracking is on for ${repoId}. Next: register accounts (cost account), grant access (cost grant) and issue a telemetry token (cost telemetry-token).\n`);
      return 0;

    case 'disable':
      if (!(await disableCost(store, repoId!))) return fail(`cost tracking is already off for ${repoId}.`);
      await audit(repoId!, 'cost.disabled', null);
      io.stdout(`Cost tracking is off for ${repoId}. Nothing already recorded was deleted.\n`);
      return 0;

    case 'account': {
      const { email, developer, name, org, billing } = values;
      if (values.remove) {
        if (!email) return fail('--remove needs --email.');
        if (!(await removeAccount(store, repoId!, email, now))) return fail(`${email} is not registered on ${repoId}.`);
        await audit(repoId!, 'cost.account', email.toLowerCase(), 'removed');
        io.stdout(`Stopped recording ${email.toLowerCase()} on ${repoId}. What was recorded stays in the report.\n`);
        return 0;
      }
      if (!email) {
        const held = (await store.costConfig('account')).filter((a) => a.repoId === repoId && !a.removedAt);
        const line = (a: (typeof held)[number]) => `  ${[a.email, `${a.developerName} (${a.developerId})`, a.organizationId ? `organisation ${a.organizationId}` : 'any organisation', a.billing].filter(Boolean).join('  ')}\n`;
        io.stdout(held.length ? `Accounts on ${repoId}:\n${held.map(line).join('')}` : `No accounts on ${repoId}.\n`);
        return 0;
      }
      if (!developer || !name) return fail('--email, --developer and --name are needed to register an account.');
      if (billing !== undefined && billing !== 'api' && billing !== 'subscription') return fail('--billing must be api or subscription.');
      const result = await saveAccount(store, { repoId: repoId!, email, developerId: developer, developerName: name, organizationId: org ?? null, billing: billing ?? null });
      if (result.status === 'conflict') return fail(`${result.reason}.`);
      await audit(repoId!, 'cost.account', email.toLowerCase(), `registered as ${developer}`);
      io.stdout(`Registered ${email.toLowerCase()} as ${name} (${developer}) on ${repoId}.\n`);
      if (!org) io.stdout('No --org: usage under this email counts whichever organisation it is signed in to, including a personal plan. For Claude Code, set --org to the company organisation id.\n');
      return 0;
    }

    case 'grant': {
      if (!values.reader) return fail('--reader is required.');
      if (values.revoke) {
        if (!(await revokeCost(store, repoId!, values.reader))) return fail(`${values.reader} has no cost access on ${repoId}.`);
        await audit(repoId!, 'cost.revoked', values.reader);
        io.stdout(`${values.reader} can no longer see developer cost on ${repoId}.\n`);
        return 0;
      }
      await grantCost(store, repoId!, values.reader);
      await audit(repoId!, 'cost.granted', values.reader);
      io.stdout(`${values.reader} can now see developer cost on ${repoId}.\n`);
      return 0;
    }

    case 'company': {
      if (!values.match) {
        const held = await store.costConfig('pattern');
        io.stdout(held.length ? `Company repos, as well as those with tracking on:\n${held.map((p) => `  ${p.pattern}\n`).join('')}` : 'No company repos set beyond those with tracking on.\n');
        return 0;
      }
      if (values.remove) {
        if (!(await removePattern(store, values.match))) return fail(`${values.match} is not set.`);
        io.stdout(`Company repos no longer include ${values.match.toLowerCase()}. Usage already recorded keeps its label.\n`);
        return 0;
      }
      if (!(await savePattern(store, values.match))) return fail('--match must be one repo (github.com/acme/webapp) or a whole organisation (github.com/acme/*).');
      io.stdout(`Company repos now include ${values.match.toLowerCase()}.\n`);
      return 0;
    }

    case 'telemetry-token': {
      if (!values.label) return fail('--label is required.');
      if (values.revoke) {
        if (!(await revokeIngestToken(store, values.label))) return fail(`there is no telemetry token labelled ${values.label}.`);
        io.stdout(`Revoked the telemetry token ${values.label}.\n`);
        return 0;
      }
      const { token } = await issueIngestToken(store, values.label, now);
      io.stdout(`Telemetry token ${values.label}. It can send usage and read nothing. It is shown only this once:\n${token}\nIssuing another with this label revokes this one.\n`);
      return 0;
    }

    case 'price': {
      const { model, since } = values;
      const usd = (v: string | undefined) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
      const [input, output] = [usd(values.input), usd(values.output)];
      const [read, write] = [values['cache-read'] === undefined ? input : usd(values['cache-read']), values['cache-write'] === undefined ? input : usd(values['cache-write'])];
      if (!model || !since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) return fail('--model and --since (a date such as 2026-04-01) are needed.');
      if ([input, output, read, write].some(Number.isNaN)) return fail('--input, --output, --cache-read and --cache-write are dollars per million tokens, e.g. 1.25.');
      await savePrice(store, { model, from: since, inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: read, cacheWritePerMTok: write });
      io.stdout(`From ${since}, ${model} costs $${input} in, $${output} out, $${read} cache read and $${write} cache write per million tokens.\n`);
      return 0;
    }

    case 'retention': {
      const days = values.days;
      if (days !== 'forever' && (!days || !/^\d+$/.test(days) || Number(days) < 1)) return fail('--days must be a whole number of days from 1, or forever.');
      await store.putCostConfig('retention', 'cost', { days: days === 'forever' ? 0 : Number(days) });
      io.stdout(days === 'forever' ? 'AI cost is kept for good.\n' : `AI cost is kept ${days} days.\n`);
      return 0;
    }

    case 'delete': {
      if (!values.developer) return fail('--developer is required.');
      if (!values.yes) return fail(`this permanently deletes every AI cost record, commit and flag for ${values.developer}. Run it again with --yes to go ahead.`);
      const r = await store.deleteCostData(values.developer);
      const repos = new Set((await store.costConfig('account')).filter((a) => a.developerId === values.developer).map((a) => a.repoId));
      for (const repo of repos) await audit(repo, 'cost.deleted', values.developer, count(r.records, 'record', 'records'));
      io.stdout(`Deleted ${values.developer}'s AI cost data: ${count(r.records, 'record', 'records')}, ${count(r.commits, 'commit', 'commits')}, ${count(r.flags, 'flag', 'flags')}.\n`);
      return 0;
    }

    default: {
      const [accounts, grants, days] = [(await store.costConfig('account')).filter((a) => !a.removedAt), await store.costConfig('grant'), await costRetentionDays(store)];
      const names = (list: string[]) => list.join(', ') || 'none';
      for (const r of await store.costConfig('repo')) {
        io.stdout(`${r.repoId}  on since ${r.enabledAt.slice(0, 10)}\n`);
        io.stdout(`  accounts: ${names(accounts.filter((a) => a.repoId === r.repoId).map((a) => a.email))}\n`);
        io.stdout(`  cost access: ${names(grants.filter((g) => g.repoId === r.repoId).map((g) => g.readerId))}\n`);
      }
      io.stdout(`Company repos: ${names((await store.costConfig('pattern')).map((p) => p.pattern))}\n`);
      io.stdout(`Prices: ${names((await store.costConfig('price')).map((p) => `${p.model} from ${p.from}`))}\n`);
      io.stdout(`Telemetry tokens: ${names((await store.costConfig('ingest')).map((t) => `${t.label} (${t.createdAt.slice(0, 10)})`))}\n`);
      io.stdout(`AI cost is kept ${days === null ? 'for good' : `${days} days`}.\n`);
      return 0;
    }
  }
}

/**
 * A local listener for checking what an agent sends (12.1), before anything is stored. It prints field names and whether a
 * record would be kept, never a prompt, command or other content, and keeps nothing.
 */
export async function startTrial({ port, stdout }: { port: number; stdout: (text: string) => void }): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => void chunks.push(c));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        stdout('A request arrived that is not JSON. Set the protocol to http/json.\n');
      }
      for (const r of describeTelemetry(body) ?? []) {
        stdout(`${r.name}: ${r.event ? 'would be recorded, if the account is registered' : 'ignored'}\n`);
        if (r.event) {
          stdout(`  account ${r.event.account}, organization.id ${r.event.organizationId ?? 'not sent'}\n`);
          stdout(`  repo reported: ${r.event.repoId ? 'yes' : 'no'}; cost reported: ${r.event.costMicros === null ? 'no' : 'yes'}\n`);
        }
        stdout(`  fields: ${r.fields.join(', ')}\n`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((listening) => server.listen(port, '127.0.0.1', listening));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((closed) => (server.closeAllConnections(), server.close(() => closed()))) };
}
