// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, the login provider's custody at the process level. A hosted
// provider's secret key (`sb_secret_...`) is read from an `apikey` header as
// well as the bearer, so the `auth` destination declares that header in
// custody's own list and custody sets it; no caller names it, and no other
// destination gets it. The planted key never shows in custody's log, a fault,
// an echoed answer or a refusal. And a credentials file without the service
// key stops the enrolment's custody at start, naming the reference only.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  authDestination,
  enrolmentSettings,
  startEnrolment,
} from '../../apps/api/enrolment-broker.ts';
import {
  parseDestinations,
  startCustody,
  type Custody,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';

const authKey = `sb_secret_canary${randomBytes(12).toString('hex')}`;
const otherKey = `other-canary-${randomBytes(12).toString('hex')}`;

/** A loopback provider: records each request's headers; `/echo/<status>` echoes them back. */
const seen: { readonly path: string; readonly headers: IncomingHttpHeaders }[] = [];
let server: Server;
let origin = '';
let folder = '';
let custody: Custody;

const writeCredentials = (entries: readonly object[]): string => {
  const file = join(folder, `credentials-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
  return file;
};

const held = (ref: string, destination: string, value: string): object => ({
  ref,
  kind: 'api_key',
  account: `${destination}-1`,
  destination,
  header: 'authorization',
  value,
});

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    seen.push({ path, headers: request.headers });
    request.resume();
    request.on('end', () => {
      const status = path.startsWith('/echo/') ? Number(path.slice(6)) : 200;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.headers));
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'c39t-auth-custody-'));
  const auth = authDestination(origin);
  custody = await startCustody({
    credentialsFile: writeCredentials([
      held('auth_key', 'auth', authKey),
      held('other_key', 'other', otherKey),
    ]),
    destinations: [
      {
        ...auth,
        routes: [
          ...(auth.routes ?? []),
          { method: 'POST', path: '/echo/200' },
          { method: 'POST', path: '/echo/401' },
        ],
      },
      { key: 'other', origin },
    ],
  });
});

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((done) => {
    server?.close(() => {
      done();
    });
  });
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

const request = (destination: string, path: string): OutboundRequest => ({
  destination,
  path,
  method: 'POST',
  body: '{}',
  timeoutMs: 2_000,
  maxResponseBytes: 8_192,
});

/** The headers the provider saw on the next request custody sends. */
async function headersOf(ref: string, sent: OutboundRequest): Promise<IncomingHttpHeaders> {
  const before = seen.length;
  await custody.dispatch(ref, sent);
  const [one] = seen.slice(before);
  if (one === undefined) throw new Error('the provider saw nothing');
  return one.headers;
}

it("C39-T custody key header: the auth destination asks for the key in 'apikey', and its call carries it there as well as in its bearer", async () => {
  const headers = await headersOf('auth_key', request('auth', '/auth/v1/admin/users'));
  expect(headers['authorization']).toBe(`Bearer ${authKey}`);
  expect(headers['apikey']).toBe(authKey);
});

it("C39-T custody key header: no other destination gets 'apikey', and a list that names it wrongly is refused whole", async () => {
  const headers = await headersOf('other_key', request('other', '/echo/200'));
  expect(headers['authorization']).toBe(`Bearer ${otherKey}`);
  expect(headers['apikey']).toBeUndefined();
  expect(JSON.stringify(headers)).not.toContain(authKey);
  const named = (entry: object): unknown => parseDestinations([{ key: 'auth', origin, ...entry }]);
  expect(named({ keyHeader: 'apikey' })).toMatchObject({ ok: true });
  for (const keyHeader of ['authorization', 'x-api-key', 'Apikey', 'api key', '', 7, null]) {
    expect(named({ keyHeader }), String(keyHeader)).toStrictEqual({
      ok: false,
      code: 'DESTINATION_MALFORMED',
      at: 0,
    });
  }
  // A fixed header of the same name would be overwritten or doubled: refused.
  expect(named({ keyHeader: 'apikey', headers: { apikey: 'fixed-value' } })).toMatchObject({
    ok: false,
  });
});

it("C39-T custody key header canary: the key never shows in custody's log, a fault, an echoed answer or a refusal", async () => {
  const echoed = await custody.dispatch('auth_key', request('auth', '/echo/200'));
  expect(echoed.kind === 'answered' && echoed.outbound.ok).toBe(true);
  // The provider echoes every header it got, `apikey` included: custody redacts it.
  expect(JSON.stringify(echoed)).toContain('[redacted]');
  const outcomes = [
    echoed,
    await custody.dispatch('auth_key', request('auth', '/echo/401')),
    await custody.dispatch('auth_key', request('auth', '/auth/v1/otp')),
    await custody.dispatch('auth_key', request('other', '/echo/200')),
    await custody.dispatch('missing_key', request('auth', '/auth/v1/admin/users')),
  ];
  const seenText = [JSON.stringify(outcomes), custody.stderr()].join('\n');
  expect(seenText).not.toContain(authKey);
  expect(seenText).not.toContain(Buffer.from(authKey).toString('base64'));
  expect(seenText).not.toContain(otherKey);
});

it('C39-T enrolment fails closed: a credentials file without auth_key stops the enrolment custody at start, naming the reference and never a value', async () => {
  const credentialsFile = writeCredentials([
    held('other_key', 'other', otherKey),
    // The right name for another destination is no service key either.
    held('auth_key', 'email', authKey),
  ]);
  const settings = enrolmentSettings({
    ENROLMENT: 'on',
    ENROLMENT_AUTH_ORIGIN: origin,
    ENROLMENT_CREDENTIALS_FILE: credentialsFile,
  });
  if (settings.kind !== 'on') throw new Error(`enrolment settings: ${settings.kind}`);
  let error: unknown;
  try {
    const running = await startEnrolment(settings, async () => await Promise.resolve([]));
    await running.stop();
  } catch (cause) {
    error = cause;
  }
  expect(error, 'enrolment started without its service key').toBeInstanceOf(Error);
  const { message } = error as Error;
  expect(message).toContain('credential auth_key missing');
  expect(message).not.toContain(authKey);
  expect(message).not.toContain(otherKey);
  expect(message).not.toContain(credentialsFile);
}, 15_000);
