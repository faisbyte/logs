// Fake-secret corpus for redaction tests.
// Every value is assembled at runtime from fragments and a seeded PRNG, so no realistic
// secret literal is committed (keeps GitHub push protection and secret scanning quiet).
import type { PlaceholderType } from '../../src/redact/types.js';

export interface CorpusEntry {
  type: PlaceholderType;
  /** The sensitive value; no part of it may survive redaction. */
  secret: string;
  /** Realistic texts that embed the secret. */
  contexts: string[];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261028);
const ALNUM_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
export const base62 = (n: number) => pick(BASE62, n);
export const base64url = (n: number) => pick(`${BASE62}-_`, n);
const base64 = (n: number) => pick(`${BASE62}+/`, n);

// Contexts that put a secret mid-sentence, inside JSON and inside a tool argument.
const embed = (secret: string, envKey: string) => [
  `I pasted ${secret} by mistake, can you rotate it?`,
  JSON.stringify({ config: { region: 'ap-southeast-2', value: secret } }),
  `curl -s -H "x-api-key: ${secret}" https://api.example.com/v1/items`,
  `${envKey}=${secret}`,
];

const awsDocExample = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const awsGenerated = `AKIA${pick(ALNUM_UPPER, 16)}`;

const awsSecretDocExample = ['wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'].join('');
const awsSecretGenerated = base64(40);
const awsSecretContexts = (secret: string) => [
  `[default]\naws_access_key_id = ${awsGenerated}\naws_secret_access_key = ${secret}\n`,
  `export AWS_SECRET_ACCESS_KEY=${secret}`,
  JSON.stringify({ Credentials: { AccessKeyId: awsGenerated, SecretAccessKey: secret, SessionToken: 'x' } }),
];
const githubClassic = `ghp_${base62(36)}`;
const githubOauth = `gho_${base62(36)}`;
const githubFineGrained = `github_pat_${base62(22)}_${base62(59)}`;
const anthropicKey = `sk-ant-api03-${base64url(93)}AA`;
const openaiProject = `sk-proj-${base64url(64)}`;
const openaiLegacy = `sk-${base62(48)}`;

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const jwt = () => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: `user-${base62(6)}`, iat: 1767225600 })}.${base64url(43)}`;
const jwtToken = jwt();

// PEM armour assembled from fragments; the body is random base64, not a real key.
export const pem = (label: string, lines = 6) =>
  [`-----BEGIN ${label}-----`, ...Array.from({ length: lines }, () => base64(64)), `-----END ${label}-----`].join('\n');
const pk = (kind: string) => `${kind}PRIVATE ${'KEY'}`;
const rsaKey = pem(pk('RSA '));
const opensshKey = pem(pk('OPENSSH '));
const pkcs8Key = pem(pk(''));
const pgpKey = pem(`PGP ${pk('')} BLOCK`);
const keyBody = (block: string) => block.split('\n').slice(1, -1).join('\n');

export const corpus: CorpusEntry[] = [
  { type: 'aws_key', secret: awsDocExample, contexts: embed(awsDocExample, 'AWS_ACCESS_KEY_ID') },
  { type: 'aws_key', secret: awsGenerated, contexts: [...embed(awsGenerated, 'AWS_ACCESS_KEY_ID'), `aws configure set aws_access_key_id ${awsGenerated}`] },
  { type: 'aws_secret', secret: awsSecretDocExample, contexts: awsSecretContexts(awsSecretDocExample) },
  { type: 'aws_secret', secret: awsSecretGenerated, contexts: awsSecretContexts(awsSecretGenerated) },
  { type: 'github_token', secret: githubClassic, contexts: [...embed(githubClassic, 'GITHUB_TOKEN'), `git clone https://${githubClassic}@github.com/acme/webapp.git`] },
  { type: 'github_token', secret: githubOauth, contexts: embed(githubOauth, 'GH_TOKEN') },
  { type: 'github_token', secret: githubFineGrained, contexts: embed(githubFineGrained, 'GITHUB_PAT') },
  { type: 'anthropic_key', secret: anthropicKey, contexts: embed(anthropicKey, 'ANTHROPIC_API_KEY') },
  { type: 'openai_key', secret: openaiProject, contexts: embed(openaiProject, 'OPENAI_API_KEY') },
  { type: 'openai_key', secret: openaiLegacy, contexts: embed(openaiLegacy, 'OPENAI_API_KEY') },
  { type: 'jwt', secret: jwtToken, contexts: [...embed(jwtToken, 'SESSION_JWT'), `Authorization: Bearer ${jwtToken}`] },
  { type: 'private_key', secret: keyBody(rsaKey), contexts: [`Here is the deploy key:\n${rsaKey}\nkeep it safe`, `cat ~/.ssh/id_rsa\n${rsaKey}`] },
  { type: 'private_key', secret: keyBody(opensshKey), contexts: [opensshKey] },
  // Service-account JSON stores the PEM with escaped newlines.
  { type: 'private_key', secret: keyBody(pkcs8Key).split('\n')[0]!, contexts: [JSON.stringify({ type: 'service_account', private_key: pkcs8Key, client_email: 'bot@acme.iam' })] },
  { type: 'private_key', secret: keyBody(pgpKey), contexts: [pgpKey] },
  // Truncated tool output: BEGIN without END.
  { type: 'private_key', secret: keyBody(rsaKey).split('\n')[0]!, contexts: [rsaKey.split('\n').slice(0, 3).join('\n')] },
];
