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

// Contexts that put a secret mid-sentence, inside JSON and inside a tool argument.
const embed = (secret: string, envKey: string) => [
  `I pasted ${secret} by mistake, can you rotate it?`,
  JSON.stringify({ config: { region: 'ap-southeast-2', value: secret } }),
  `curl -s -H "x-api-key: ${secret}" https://api.example.com/v1/items`,
  `${envKey}=${secret}`,
];

const awsDocExample = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const awsGenerated = `AKIA${pick(ALNUM_UPPER, 16)}`;

export const corpus: CorpusEntry[] = [
  { type: 'aws_key', secret: awsDocExample, contexts: embed(awsDocExample, 'AWS_ACCESS_KEY_ID') },
  { type: 'aws_key', secret: awsGenerated, contexts: [...embed(awsGenerated, 'AWS_ACCESS_KEY_ID'), `aws configure set aws_access_key_id ${awsGenerated}`] },
];
