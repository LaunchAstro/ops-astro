// SPDX-License-Identifier: AGPL-3.0-only
//
// The mail provider's key can do anything its account can (create keys, read
// contacts, send broadcasts), so custody presents it only on the paths its
// destination lists: one exact POST path for the send and one exact GET for
// the sending domain's status. Any other POST or GET is refused by custody
// before a socket exists, and the provider hears nothing. A destination with
// no POST list takes a POST to any plain path, as before.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  parseDestinations,
  startCustody,
  type Custody,
  type CustodyOutcome,
} from '../../packages/core-custody/src/index.ts';

const seen: string[] = [];
const domainId = randomUUID();
/** A credential custody presents to one destination. */
const credential = (ref: string, destination: string) => ({
  ref,
  kind: 'api_key',
  account: 'mail-1',
  destination,
  header: 'authorization',
  value: `canary-${randomBytes(18).toString('hex')}`,
});

let server: Server;
let custody: Custody;
let folder: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'email-post-paths-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([credential('email_key', 'email'), credential('other_key', 'other')]),
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
      { key: 'other', origin },
    ],
  });
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

const asked = (destination: string, method: 'POST' | 'GET', path: string) => ({
  destination,
  method,
  path,
  body: method === 'POST' ? '{}' : '',
  timeoutMs: 2_000,
  maxResponseBytes: 4_096,
});

/** Custody sent nothing: refused before dispatch, or answered that the path is not routed. */
const unsent = (outcome: CustodyOutcome): boolean =>
  outcome.kind === 'refused' ||
  (outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault === 'bad_path');

it('the mail key is refused by custody on any POST path but the send, and the provider hears nothing', async () => {
  for (const path of ['/api-keys', '/contacts', '/domains', '/broadcasts', '/emails/batch']) {
    // oxlint-disable-next-line no-await-in-loop -- one refusal after another
    const outcome = await custody.dispatch('email_key', asked('email', 'POST', path));
    expect(unsent(outcome), path).toBe(true);
  }
  expect(seen).toEqual([]);
  const sent = await custody.dispatch('email_key', asked('email', 'POST', '/emails'));
  expect(sent).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toEqual(['POST /emails']);
});

it('the mail key is refused by custody on any GET but its one sending domain', async () => {
  seen.length = 0;
  for (const path of [`/domains/${randomUUID()}`, '/domains', '/api-keys', `/emails/${domainId}`]) {
    // oxlint-disable-next-line no-await-in-loop -- one refusal after another
    const outcome = await custody.dispatch('email_key', asked('email', 'GET', path));
    expect(unsent(outcome), path).toBe(true);
  }
  expect(seen).toEqual([]);
  const read = await custody.dispatch('email_key', asked('email', 'GET', `/domains/${domainId}`));
  expect(read).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toEqual([`GET /domains/${domainId}`]);
});

it('a destination with no POST list still takes a POST to any plain path', async () => {
  seen.length = 0;
  const outcome = await custody.dispatch('other_key', asked('other', 'POST', '/v1/anything'));
  expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toEqual(['POST /v1/anything']);
});

it('a POST list is refused at load when it names no path, a malformed one, or sits beside no POST at all', () => {
  const origin = 'https://mail.example.com';
  const load = (extra: Record<string, unknown>) =>
    parseDestinations([{ key: 'email', origin, ...extra }]);
  expect(load({ posts: ['/emails'] })).toMatchObject({ ok: true });
  const refused: Record<string, unknown>[] = [
    { posts: [] },
    { posts: '/emails' },
    { posts: ['emails'] },
    { posts: ['/emails/../api-keys'] },
    { posts: ['/emails/*'] },
    { posts: ['//evil.example.com/emails'] },
    { posts: [7] },
    { posts: ['/emails'], post: false },
  ];
  for (const extra of refused) {
    expect(load(extra), JSON.stringify(extra)).toMatchObject({
      ok: false,
      code: 'DESTINATION_MALFORMED',
    });
  }
});
