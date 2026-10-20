// SPDX-License-Identifier: AGPL-3.0-only
//
// The real sending-domain source: the provider's domain answer is read
// through custody, on the one GET route its destination lists, with the key
// custody holds; the root's DMARC records come from DNS. A report drawn from
// it is not mock, and is verified only when the provider says all three
// records are verified for exactly the sending subdomain. Here the provider
// is a loopback stand-in answering its domain shape, and DNS is handed in.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { checkSender } from '../../packages/core-connectors/src/index.ts';
import {
  custodySenderSource,
  startCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';

const SUBDOMAIN = 'send.example.test';
const ROOT = 'example.test';
const domainId = randomUUID();
const canary = `canary-${randomBytes(18).toString('hex')}`;

let answer: { status: number; body: unknown };
const heard: { method: string; url: string; authorization: string | undefined }[] = [];
let server: Server;
let custody: Custody;
let folder: string;

const verifiedAnswer = (status = 'verified', name = SUBDOMAIN): unknown => ({
  object: 'domain',
  id: domainId,
  name,
  status: 'verified',
  region: 'us-east-1',
  records: [
    { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status, value: 'x', priority: 10 },
    { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'x' },
    { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', status: 'verified', value: 'p=' },
  ],
});

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      heard.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers['authorization'],
      });
      response
        .writeHead(answer.status, { 'content-type': 'application/json' })
        .end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'email-sender-custody-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'email_key',
        kind: 'api_key',
        account: 'mail-1',
        destination: 'email',
        header: 'authorization',
        scheme: 'bearer',
        value: canary,
      },
    ]),
    { mode: 0o600 },
  );
  custody = await startCustody({
    credentialsFile,
    destinations: [
      {
        key: 'email',
        origin,
        posts: ['/emails'],
        routes: [{ method: 'GET', path: `/domains/${domainId}` }],
      },
    ],
  });
}, 60_000);

beforeEach(() => {
  heard.length = 0;
  answer = { status: 200, body: verifiedAnswer() };
});

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

const quarantine = async (): Promise<string[][]> =>
  await Promise.resolve([['v=DMARC1; p=quarantine']]);

const source = (dmarc: () => Promise<string[][]> = quarantine) =>
  custodySenderSource(
    custody,
    { credentialRef: 'email_key', destination: 'email', domainId },
    dmarc,
  );

it('the provider’s domain answer, read through custody with its key, verifies the sending subdomain and is not mock', async () => {
  const report = await checkSender(source(), SUBDOMAIN, ROOT);
  expect(report).toMatchObject({
    subdomain: SUBDOMAIN,
    verified: true,
    records: { dkim: 'verified', spf: 'verified', returnPathMx: 'verified' },
    dmarc: 'quarantine',
    mock: false,
  });
  expect(heard).toEqual([
    { method: 'GET', url: `/domains/${domainId}`, authorization: `Bearer ${canary}` },
  ]);
  expect(JSON.stringify(report)).not.toContain(canary);
});

it('a record not verified, another name, an error status or a malformed answer is not verified', async () => {
  const cases: { status: number; body: unknown }[] = [
    { status: 200, body: verifiedAnswer('pending') },
    { status: 200, body: verifiedAnswer('verified', 'other.example.test') },
    { status: 500, body: { message: 'down' } },
    { status: 200, body: 'not json at all' },
  ];
  for (const next of cases) {
    answer = next;
    // oxlint-disable-next-line no-await-in-loop -- one case after another
    const report = await checkSender(source(), SUBDOMAIN, ROOT);
    expect(report.verified, JSON.stringify(next)).toBe(false);
    expect(report.mock).toBe(false);
  }
});

it('a root with no DMARC record reads as missing and does not stop a verified subdomain; a DNS fault does', async () => {
  const absent = Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
  const none = await checkSender(
    source(async () => await Promise.reject(absent)),
    SUBDOMAIN,
    ROOT,
  );
  expect(none).toMatchObject({ verified: true, dmarc: 'missing' });
  const fault = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
  const down = await checkSender(
    source(async () => await Promise.reject(fault)),
    SUBDOMAIN,
    ROOT,
  );
  expect(down.verified).toBe(false);
});
