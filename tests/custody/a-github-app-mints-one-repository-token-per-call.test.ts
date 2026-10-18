// SPDX-License-Identifier: AGPL-3.0-only
//
// The site's source entry as a GitHub App (#1793): custody holds only the
// App's private key and mints, at call time, an installation token for the
// one repository the correction's party is bound to. A correction naming
// another repository is refused before any request leaves custody. A local
// stand-in plays both the App's token endpoint and the repository API, and
// checks the token request's signature against the App's public key.

import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  callConnector,
  siteOperation,
  type CallDependencies,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseCredentials,
  siteCustody,
  siteDestination,
  startCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';

const APP_ID = '424242';
const AGENCY = {
  party: 'party-agency',
  repository: 'LaunchAstro/agency-astro-astro',
  installation: 71,
};
const CLIENT = { party: 'party-client', repository: 'ClientCo/client-site', installation: 72 };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}
const seen: Seen[] = [];
const minted: string[] = [];
/** How the stand-in answers a token request: a fresh token unless a test says otherwise. */
let mintAnswer: (repository: string) => { status: number; body: unknown };
let echoing = false;
let server: Server;
let custody: Custody;
let folder: string;
let origin: string;

const freshToken = (repository: string) => {
  const token = `ghs_${randomBytes(18).toString('hex')}`;
  minted.push(token);
  return {
    status: 201,
    body: {
      token,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      repository_selection: 'selected',
      repositories: [{ full_name: repository }],
    },
  };
};

/** The JWT's claims when its RS256 signature is the App key's, else undefined. */
function claimsOf(authorization: string): Record<string, unknown> | undefined {
  const [header = '', payload = '', signature = ''] = authorization
    .replace('Bearer ', '')
    .split('.');
  const good = verify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })),
    Buffer.from(signature, 'base64url'),
  );
  if (!good) return undefined;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const ENTRY = {
  ref: 'source_control',
  kind: 'api_key',
  account: `github-app-${APP_ID}`,
  destination: 'source_control',
  header: 'authorization',
  scheme: 'github_app',
  app: { id: APP_ID, bindings: [AGENCY, CLIENT] },
  value: KEY,
};

/** The stand-in for GitHub: the App's token endpoint and the repository's contents. */
function standIn(request: IncomingMessage, response: ServerResponse): void {
  const parts: Buffer[] = [];
  request.on('data', (part: Buffer) => parts.push(part));
  request.on('end', () => {
    const body = Buffer.concat(parts).toString('utf8');
    const authorization = request.headers.authorization ?? '';
    seen.push({ method: request.method ?? '', url: request.url ?? '', authorization, body });
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(request.url ?? '');
    if (mint !== null) {
      const binding = [AGENCY, CLIENT].find((one) => String(one.installation) === mint[1]);
      const answer = mintAnswer(binding?.repository ?? 'none/none');
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
      return;
    }
    const token = authorization.replace('Bearer ', '');
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        content: Buffer.from('<h1>About</h1>').toString('base64'),
        encoding: 'base64',
        sha: echoing ? token : 'blob-1',
      }),
    );
  });
}

beforeAll(async () => {
  server = createServer(standIn);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'site-app-'));
  const credentialsFile = join(folder, 'site.json');
  writeFileSync(credentialsFile, JSON.stringify([ENTRY]), { mode: 0o600 });
  custody = await startCustody({
    credentialsFile,
    destinations: [siteDestination('source_control', origin)],
  });
}, 60_000);

beforeEach(() => {
  seen.length = 0;
  minted.length = 0;
  echoing = false;
  mintAnswer = freshToken;
});

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

const deps = (party?: string): CallDependencies => ({
  transport: () => Promise.resolve({ kind: 'failed' }),
  resolve: () => Promise.resolve(['76.76.21.21']),
  credential: (ref) => Promise.resolve({ ref }),
  custody: siteCustody(custody, party),
  record: () => null,
});

const readAbout = async (party: string | undefined, repository: string) =>
  await callConnector(
    siteOperation('site.source.read'),
    { repository, path: 'src/pages/about.astro', ref: 'main' },
    deps(party),
  );

it('a source read mints a token for its party repository alone, signed by the App key, and sends with it', async () => {
  const result = await readAbout(AGENCY.party, AGENCY.repository);
  expect(result.kind).toBe('ok');
  expect(seen.map((one) => `${one.method} ${one.url.split('?')[0] ?? ''}`)).toEqual([
    `POST /app/installations/${String(AGENCY.installation)}/access_tokens`,
    `GET /repos/${AGENCY.repository}/contents/src/pages/about.astro`,
  ]);
  const [mint, read] = seen;
  const claims = claimsOf(mint!.authorization);
  expect(claims?.['iss']).toBe(APP_ID);
  expect(Number(claims?.['exp']) - Number(claims?.['iat'])).toBeLessThanOrEqual(600);
  expect(JSON.parse(mint!.body)).toEqual({
    repositories: ['agency-astro-astro'],
    permissions: { contents: 'write', pull_requests: 'write' },
  });
  expect(read!.authorization).toBe(`Bearer ${minted[0] ?? 'none'}`);
});

it('each call mints its own token: none is kept for the next', async () => {
  await readAbout(AGENCY.party, AGENCY.repository);
  await readAbout(AGENCY.party, AGENCY.repository);
  const reads = seen.filter((one) => one.method === 'GET').map((one) => one.authorization);
  expect(minted).toHaveLength(2);
  expect(reads).toEqual(minted.map((token) => `Bearer ${token}`));
});

it.each([
  ['another party repository', AGENCY.party, CLIENT.repository],
  ['another repository of the same owner', AGENCY.party, 'LaunchAstro/website-template'],
  ['the bound repository spelt in another case', AGENCY.party, 'launchastro/Agency-Astro-Astro'],
  ['a party with no binding', 'party-unknown', AGENCY.repository],
  ['no party at all', undefined, AGENCY.repository],
])('%s is refused before any request leaves custody', async (_case, party, repository) => {
  const result = await readAbout(party, repository);
  expect(result).toMatchObject({ kind: 'refused', code: 'CUSTODY_REPOSITORY_NOT_BOUND' });
  expect(seen).toEqual([]);
});

it.each([
  ['a path stepping out of the bound repository', '/../../ClientCo/client-site'],
  ['an escaped step out of it', '/%2e%2e/%2e%2e/ClientCo/client-site'],
])('%s is refused before any request leaves custody', async (_case, step) => {
  const outcome = await custody.dispatch('source_control', {
    party: AGENCY.party,
    destination: 'source_control',
    path: `/repos/${AGENCY.repository}${step}/contents/src/pages/about.astro?ref=main`,
    method: 'GET',
    body: '',
    timeoutMs: 5_000,
    maxResponseBytes: 262_144,
  });
  expect(outcome).toMatchObject({ kind: 'refused', started: false });
  expect(seen).toEqual([]);
});

it('the client party mints only for its own repository, under its own installation', async () => {
  expect((await readAbout(CLIENT.party, CLIENT.repository)).kind).toBe('ok');
  expect(seen[0]?.url).toBe(`/app/installations/${String(CLIENT.installation)}/access_tokens`);
  expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ repositories: ['client-site'] });
});

it.each([
  ['a refused token request', () => ({ status: 403, body: { message: 'no' } })],
  [
    'a token for more than the one repository',
    (repository: string) => ({
      status: 201,
      body: {
        ...(freshToken(repository).body as object),
        repositories: [{ full_name: repository }, { full_name: 'LaunchAstro/other' }],
      },
    }),
  ],
  [
    'a token already expired',
    (repository: string) => ({
      status: 201,
      body: { ...(freshToken(repository).body as object), expires_at: '2020-01-01T00:00:00Z' },
    }),
  ],
  ['an answer with no token', () => ({ status: 201, body: { expires_at: 'soon' } })],
])('%s sends nothing to the repository', async (_case, answer) => {
  mintAnswer = answer;
  const result = await readAbout(AGENCY.party, AGENCY.repository);
  expect(result).toMatchObject({ kind: 'refused', code: 'CUSTODY_TOKEN_NOT_MINTED' });
  expect(seen.map((one) => one.method)).toEqual(['POST']);
});

it('the key, the signed request and the minted token never reach the caller or a log', async () => {
  const result = await readAbout(AGENCY.party, AGENCY.repository);
  echoing = true;
  const echoed = await readAbout(AGENCY.party, AGENCY.repository);
  expect(echoed.kind).not.toBe('ok');
  const keyBody = KEY.split('\n')[1] ?? KEY;
  const out = JSON.stringify([result, echoed]) + custody.stderr();
  for (const secret of [keyBody, ...minted, ...seen.map((one) => one.authorization.slice(7))]) {
    expect(out.includes(secret), 'a secret reached the caller or stderr').toBe(false);
  }
});

it('custody refuses an App entry it could not mint with', () => {
  const entry = { ...ENTRY, app: { id: APP_ID, bindings: [AGENCY] } };
  expect(parseCredentials([entry]).ok).toBe(true);
  const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  for (const bad of [
    { ...entry, value: 'not-a-private-key-at-all' },
    { ...entry, value: ecKey },
    { ...entry, app: { id: '12ab', bindings: [AGENCY] } },
    { ...entry, app: { id: APP_ID, bindings: [AGENCY, { ...CLIENT, party: AGENCY.party }] } },
    {
      ...entry,
      app: { id: APP_ID, bindings: [AGENCY, { ...CLIENT, repository: AGENCY.repository }] },
    },
    { ...entry, app: { id: APP_ID, bindings: [{ ...AGENCY, repository: 'LaunchAstro/../x' }] } },
    { ...entry, app: { id: APP_ID, bindings: [{ ...AGENCY, installation: 0 }] } },
    { ...entry, app: { id: APP_ID, bindings: [AGENCY] }, extra: true },
    { ...entry, header: 'x-api-key' },
  ]) {
    expect(parseCredentials([bad])).toMatchObject({ ok: false, code: 'CREDENTIAL_MALFORMED' });
  }
});
